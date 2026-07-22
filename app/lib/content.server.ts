import {
  listContentFiles,
  getFileContent,
  createOrUpdateFile,
  deleteFile,
  getFileHistory,
  getFileAtCommit,
  listPublishedFiles,
  getPublishedFileContent,
  publishFile,
  unpublishFile,
  getPublishStatus,
  getPublishedFileSha,
  getFileBlobShaAtCommit,
  saveCompiledCss,
  getCompiledCss,
  slugFromFilename,
  typeFromFilename,
  type ContentType,
  type GitHubCommit,
} from "./github.server";
import {
  parseMarkdown,
  parseFrontmatterOnly,
  type ContentFrontmatter,
  type ParsedContent,
} from "./markdown.server";
import { parsePage, type ParsedPage } from "./page.server";
import { parseWikipedia, type ParsedWikipedia } from "./wikipedia.server";
import { parseTutorial, type ParsedTutorial } from "./tutorial.server";
import { contentCache } from "./cache.server";
import { listArticleIndex, upsertArticleIndex, removeFromArticleIndex } from "./articles.server";
import { listPageIndex, upsertPageIndex, removeFromPageIndex, pageIndexExists, savePageIndex, type PageIndexEntry } from "./page-index.server";
import { listTutorialIndex, upsertTutorialIndex, removeFromTutorialIndex, tutorialIndexExists, saveTutorialIndex, type TutorialIndexEntry } from "./tutorial-index.server";

export type { ContentType } from "./github.server";

export interface ContentListItem {
  slug: string;
  contentType: ContentType;
  meta: ContentFrontmatter;
  sha: string;
  published: boolean;
  upToDate: boolean;
}

export interface ContentItem extends ParsedContent {
  slug: string;
  sha: string;
  contentType: ContentType;
}

export interface PageItem extends ParsedPage {
  slug: string;
  sha: string;
  contentType: "page";
}

export interface WikipediaItem extends ParsedWikipedia {
  slug: string;
  sha: string;
  contentType: "wikipedia";
}

export interface TutorialItem extends ParsedTutorial {
  slug: string;
  sha: string;
  contentType: "tutorial";
}

export type AnyContentItem = ContentItem | PageItem | WikipediaItem | TutorialItem;

// --- Draft branch (admin UI) ---

/**
 * Fast page list from `pages.json` (one read). If the index is missing,
 * `listContent()` seeds it from a scan, then we read it back.
 */
export async function listPages(): Promise<PageIndexEntry[]> {
  if (await pageIndexExists()) return listPageIndex();
  await listContent();
  return listPageIndex();
}

/** Fast tutorial list from `tutorial.json` (one read), with the same backfill. */
export async function listTutorials(): Promise<TutorialIndexEntry[]> {
  if (await tutorialIndexExists()) return listTutorialIndex();
  await listContent();
  return listTutorialIndex();
}

export async function listContent(): Promise<ContentListItem[]> {
  // The indexes let us read each item's meta from a few JSON files instead of
  // reading every content file's frontmatter over the API.
  const [draftFiles, publishedFiles, articleIdx, pageIdx, tutorialIdx] = await Promise.all([
    listContentFiles(),
    listPublishedFiles(),
    listArticleIndex(),
    listPageIndex(),
    listTutorialIndex(),
  ]);

  const publishedMap = new Map(
    publishedFiles.map((f) => [slugFromFilename(f.name), f.sha])
  );

  // slug -> lightweight frontmatter from the indexes.
  const indexMeta = new Map<string, ContentFrontmatter>();
  for (const e of articleIdx) {
    indexMeta.set(e.slug, { title: e.title, description: e.description, tags: e.tags, headerImage: e.headerImage, publishedAt: e.publishedAt, draft: e.draft });
  }
  for (const e of pageIdx) {
    indexMeta.set(e.slug, { title: e.title, description: e.description, tags: e.tags, path: e.path, publishedAt: e.publishedAt, draft: e.draft });
  }
  for (const e of tutorialIdx) {
    indexMeta.set(e.slug, { title: e.title, description: e.description, tags: e.tags, publishedAt: e.publishedAt, draft: e.draft });
  }

  const items = await Promise.all(
    draftFiles.map(async (file) => {
      const slug = slugFromFilename(file.name);
      // Prefer the sha-keyed cache (version-correct), then the index (avoids an
      // API read), then fall back to reading the file (markdown/wiki, index gaps).
      let meta: ContentFrontmatter | undefined =
        contentCache.getMeta(slug, file.sha) ?? indexMeta.get(slug);
      if (!meta) {
        const content = await getFileContent(slug, file.contentType);
        if (!content) return null;
        meta = parseFrontmatterOnly(content.content);
        contentCache.setMeta(slug, file.sha, meta);
      }

      const publishedSha = publishedMap.get(slug);
      return {
        slug,
        contentType: file.contentType,
        meta,
        sha: file.sha,
        published: !!publishedSha,
        upToDate: publishedSha === file.sha,
      };
    })
  );

  const result = items
    .filter((item): item is ContentListItem => item !== null)
    .sort((a, b) => {
      const dateA = a.meta.publishedAt ?? "";
      const dateB = b.meta.publishedAt ?? "";
      return dateB.localeCompare(dateA);
    });

  // One-time backfill: seed a page/tutorial index that's empty while items of
  // that type exist. Awaited so `listPages`/`listTutorials` can read it back.
  const now = new Date().toISOString();
  const backfills: Promise<void>[] = [];
  const pagesR = result.filter((i) => i.contentType === "page");
  if (pageIdx.length === 0 && pagesR.length > 0) {
    backfills.push(
      savePageIndex(pagesR.map((i) => ({ slug: i.slug, title: i.meta.title, description: i.meta.description, tags: i.meta.tags, path: typeof i.meta.path === "string" ? i.meta.path : undefined, publishedAt: i.meta.publishedAt, draft: i.meta.draft, updatedAt: now })))
    );
  }
  const tutR = result.filter((i) => i.contentType === "tutorial");
  if (tutorialIdx.length === 0 && tutR.length > 0) {
    backfills.push(
      saveTutorialIndex(tutR.map((i) => ({ slug: i.slug, title: i.meta.title, description: i.meta.description, tags: i.meta.tags, publishedAt: i.meta.publishedAt, draft: i.meta.draft, updatedAt: now })))
    );
  }
  if (backfills.length) {
    try {
      await Promise.all(backfills);
    } catch (err) {
      console.error("[index] listContent backfill failed:", err);
    }
  }

  return result;
}

export async function getContent(slug: string): Promise<AnyContentItem | null> {
  // Detect content type from file listing to avoid double API calls
  const files = await listContentFiles();
  const match = files.find((f) => slugFromFilename(f.name) === slug);
  const type: ContentType = match?.contentType ?? "markdown";

  const file = await getFileContent(slug, type);
  if (!file) return null;

  const cached = contentCache.getFull(slug, file.sha);
  if (cached) {
    return { ...cached, slug, sha: file.sha, contentType: type } as AnyContentItem;
  }

  if (type === "page") {
    const parsed = parsePage(file.content);
    contentCache.setFull(slug, file.sha, parsed);
    return { ...parsed, slug, sha: file.sha, contentType: "page" };
  }

  if (type === "wikipedia") {
    const parsed = await parseWikipedia(file.content);
    contentCache.setFull(slug, file.sha, parsed);
    return { ...parsed, slug, sha: file.sha, contentType: "wikipedia" };
  }

  if (type === "tutorial") {
    const parsed = parseTutorial(file.content);
    contentCache.setFull(slug, file.sha, parsed);
    return { ...parsed, slug, sha: file.sha, contentType: "tutorial" };
  }

  // markdown + article share the markdown parser; report the real type so
  // `.article` files keep their identity.
  const parsed = await parseMarkdown(file.content);
  contentCache.setFull(slug, file.sha, parsed);
  return { ...parsed, slug, sha: file.sha, contentType: type };
}

/** Update the draft-branch index (articles/pages/tutorial) after a save. */
async function syncDraftIndex(slug: string, raw: string, type: ContentType): Promise<void> {
  const now = new Date().toISOString();
  try {
    if (type === "article") {
      const fm = parseFrontmatterOnly(raw);
      await upsertArticleIndex({ slug, title: fm.title, description: fm.description, tags: fm.tags, headerImage: fm.headerImage, publishedAt: fm.publishedAt, draft: fm.draft, updatedAt: now });
    } else if (type === "page") {
      const fm = parseFrontmatterOnly(raw);
      await upsertPageIndex({ slug, title: fm.title, description: fm.description, tags: fm.tags, path: typeof fm.path === "string" ? fm.path : undefined, publishedAt: fm.publishedAt, draft: fm.draft, updatedAt: now });
    } else if (type === "tutorial") {
      const parsed = parseTutorial(raw);
      const fm = parsed.frontmatter;
      await upsertTutorialIndex({ slug, title: fm.title, description: fm.description, tags: fm.tags, publishedAt: fm.publishedAt, draft: fm.draft, chapters: parsed.chapters.map((c) => ({ slug: c.slug, title: c.title })), updatedAt: now });
    }
  } catch (err) {
    console.error(`[index] draft update failed for ${type} ${slug}:`, err);
  }
}

/** Remove a slug from its type's draft index after a delete. */
async function removeDraftIndex(slug: string, type: ContentType): Promise<void> {
  try {
    if (type === "article") await removeFromArticleIndex(slug);
    else if (type === "page") await removeFromPageIndex(slug);
    else if (type === "tutorial") await removeFromTutorialIndex(slug);
  } catch (err) {
    console.error(`[index] draft remove failed for ${type} ${slug}:`, err);
  }
}

export async function saveContent(
  slug: string,
  raw: string,
  sha?: string,
  type: ContentType = "markdown",
  compiledCss?: string
): Promise<{ sha: string }> {
  const isNew = !sha;
  const message = isNew ? `Create ${slug}` : `Update ${slug}`;

  const result = await createOrUpdateFile(slug, raw, message, sha, type);

  // Save compiled CSS for page content type
  if (type === "page" && compiledCss != null) {
    await saveCompiledCss(slug, compiledCss);
  }

  // Keep the draft index in sync so listings don't need to read every file.
  await syncDraftIndex(slug, raw, type);

  contentCache.invalidate(slug);
  return result;
}

export async function getPageCompiledCss(
  slug: string,
  branch?: string
): Promise<string | null> {
  return getCompiledCss(slug, branch);
}

export async function removeContent(
  slug: string,
  sha: string,
  type: ContentType = "markdown"
): Promise<void> {
  await deleteFile(slug, sha, `Delete ${slug}`, type);
  await removeDraftIndex(slug, type);
  contentCache.invalidate(slug);
}

export interface ContentHistoryItem extends GitHubCommit {
  isPublished: boolean;
}

export interface ContentHistoryPage {
  items: ContentHistoryItem[];
  page: number;
  perPage: number;
  hasMore: boolean;
}

export async function getContentHistory(
  slug: string,
  type: ContentType = "markdown",
  page: number = 1,
  perPage: number = 20
): Promise<ContentHistoryPage> {
  const [commits, publishedBlobSha] = await Promise.all([
    getFileHistory(slug, undefined, type, page, perPage),
    getPublishedFileSha(slug, type),
  ]);

  if (!publishedBlobSha) {
    return {
      items: commits.map((c) => ({ ...c, isPublished: false })),
      page,
      perPage,
      hasMore: commits.length === perPage,
    };
  }

  // Parallel blob SHA lookup for the current page
  const blobShas = await Promise.all(
    commits.map((c) => getFileBlobShaAtCommit(slug, c.sha, type))
  );

  let foundPublished = false;
  const items: ContentHistoryItem[] = commits.map((commit, i) => {
    if (foundPublished) return { ...commit, isPublished: false };
    if (blobShas[i] === publishedBlobSha) {
      foundPublished = true;
      return { ...commit, isPublished: true };
    }
    return { ...commit, isPublished: false };
  });

  return {
    items,
    page,
    perPage,
    hasMore: commits.length === perPage,
  };
}

export async function getContentAtVersion(
  slug: string,
  commitSha: string,
  type: ContentType = "markdown"
): Promise<ParsedContent | null> {
  const raw = await getFileAtCommit(slug, commitSha, type);
  if (!raw) return null;
  if (type === "page") {
    return parsePage(raw);
  }
  if (type === "wikipedia") {
    return parseWikipedia(raw);
  }
  if (type === "tutorial") {
    return parseTutorial(raw);
  }
  return parseMarkdown(raw);
}

// --- Publish operations ---

export async function publishContent(slug: string, type: ContentType = "markdown"): Promise<void> {
  await publishFile(slug, type);

  const { getGitHubConfig, publishAsset } = await import("./github.server");
  const config = getGitHubConfig();

  // Also publish the compiled CSS for page content
  if (type === "page") {
    const draftCss = await getCompiledCss(slug, config.branch);
    if (draftCss) {
      await saveCompiledCss(slug, draftCss, config.publishBranch);
    }
  }

  // Publish any referenced assets (images etc.) from draft to publish branch
  const content = await getContent(slug);
  if (content) {
    const raw = "raw" in content ? (content.raw as string) : "";
    const html = "html" in content ? (content.html as string) : "";
    const projectData = "projectData" in content ? (content.projectData as string) : "";
    const allText = `${raw}\n${html}\n${projectData}`;

    // Find all /api/assets/filename references
    const assetRefs = new Set<string>();
    const regex = /\/api\/assets\/([^\s"'<>?#)]+)/g;
    let match;
    while ((match = regex.exec(allText)) !== null) {
      assetRefs.add(match[1]);
    }

    // Publish each referenced asset
    await Promise.all(
      Array.from(assetRefs).map((filename) =>
        publishAsset(filename).catch(() => {})
      )
    );
  }

  // Maintain the publish-branch index so public listings read exactly what's
  // published. Marked not-draft — being published is the signal, regardless of
  // the frontmatter "draft" flag. Best-effort (never block a publish).
  if (content) {
    const fm = content.frontmatter;
    const now = new Date().toISOString();
    try {
      if (type === "article") {
        await upsertArticleIndex({ slug, title: fm.title, description: fm.description, tags: fm.tags, headerImage: fm.headerImage, publishedAt: fm.publishedAt, draft: false, updatedAt: now }, config.publishBranch);
      } else if (type === "page") {
        await upsertPageIndex({ slug, title: fm.title, description: fm.description, tags: fm.tags, path: typeof fm.path === "string" ? fm.path : undefined, publishedAt: fm.publishedAt, draft: false, updatedAt: now }, config.publishBranch);
      } else if (type === "tutorial") {
        const chapters = "chapters" in content ? (content.chapters as { slug: string; title: string }[]).map((c) => ({ slug: c.slug, title: c.title })) : [];
        await upsertTutorialIndex({ slug, title: fm.title, description: fm.description, tags: fm.tags, publishedAt: fm.publishedAt, draft: false, chapters, updatedAt: now }, config.publishBranch);
      }
    } catch (err) {
      console.error(`[index] publish update failed for ${type} ${slug}:`, err);
    }
  }

  contentCache.invalidate(slug);
}

export async function unpublishContent(slug: string, type: ContentType = "markdown"): Promise<void> {
  await unpublishFile(slug, type);

  // Drop it from the publish-branch index (best-effort).
  const { getGitHubConfig } = await import("./github.server");
  const publishBranch = getGitHubConfig().publishBranch;
  try {
    if (type === "article") await removeFromArticleIndex(slug, publishBranch);
    else if (type === "page") await removeFromPageIndex(slug, publishBranch);
    else if (type === "tutorial") await removeFromTutorialIndex(slug, publishBranch);
  } catch (err) {
    console.error(`[index] unpublish remove failed for ${type} ${slug}:`, err);
  }

  contentCache.invalidate(slug);
}

export async function getContentPublishStatus(slug: string, type: ContentType = "markdown") {
  return getPublishStatus(slug, type);
}

// --- Published branch (public API) ---

export async function listPublishedContent(): Promise<ContentListItem[]> {
  const files = await listPublishedFiles();

  const items = await Promise.all(
    files.map(async (file) => {
      const slug = slugFromFilename(file.name);
      const cached = contentCache.getMeta(`pub:${slug}`, file.sha);
      let meta: ContentFrontmatter;
      if (cached) {
        meta = cached;
      } else {
        const content = await getPublishedFileContent(slug, file.contentType);
        if (!content) return null;
        meta = parseFrontmatterOnly(content.content);
        contentCache.setMeta(`pub:${slug}`, file.sha, meta);
      }

      return {
        slug,
        contentType: file.contentType,
        meta,
        sha: file.sha,
        published: true,
        upToDate: true,
      };
    })
  );

  return items
    .filter((item): item is ContentListItem => item !== null)
    .sort((a, b) => {
      const dateA = a.meta.publishedAt ?? "";
      const dateB = b.meta.publishedAt ?? "";
      return dateB.localeCompare(dateA);
    });
}

export async function getPublishedContent(
  slug: string
): Promise<AnyContentItem | null> {
  const files = await listPublishedFiles();
  const match = files.find((f) => slugFromFilename(f.name) === slug);
  const type: ContentType = match?.contentType ?? "markdown";

  const file = await getPublishedFileContent(slug, type);
  if (!file) return null;

  const cacheKey = `pub:${slug}`;
  const cached = contentCache.getFull(cacheKey, file.sha);
  if (cached) {
    return { ...cached, slug, sha: file.sha, contentType: type } as AnyContentItem;
  }

  if (type === "page") {
    const parsed = parsePage(file.content);
    contentCache.setFull(cacheKey, file.sha, parsed);
    return { ...parsed, slug, sha: file.sha, contentType: "page" };
  }

  if (type === "wikipedia") {
    const parsed = await parseWikipedia(file.content);
    contentCache.setFull(cacheKey, file.sha, parsed);
    return { ...parsed, slug, sha: file.sha, contentType: "wikipedia" };
  }

  if (type === "tutorial") {
    const parsed = parseTutorial(file.content);
    contentCache.setFull(cacheKey, file.sha, parsed);
    return { ...parsed, slug, sha: file.sha, contentType: "tutorial" };
  }

  const parsed = await parseMarkdown(file.content);
  contentCache.setFull(cacheKey, file.sha, parsed);
  return { ...parsed, slug, sha: file.sha, contentType: type };
}

/**
 * Normalize a user-supplied URL path to a canonical form for matching:
 * ensure a single leading slash, strip trailing slashes, lowercase.
 * Returns null for empty/invalid input.
 */
export function normalizeUrlPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let s = value.trim();
  if (!s) return null;
  s = "/" + s.replace(/^\/+/, "").replace(/\/+$/, "");
  return s.toLowerCase();
}

/**
 * Resolve a public URL path to its published content by matching the
 * `path` frontmatter field. Returns null when no published page claims it.
 */
export async function getPublishedContentByPath(
  path: string
): Promise<AnyContentItem | null> {
  const target = normalizeUrlPath(path);
  if (!target) return null;

  const items = await listPublishedContent();
  const match = items.find((it) => normalizeUrlPath(it.meta.path) === target);
  if (!match) return null;

  return getPublishedContent(match.slug);
}
