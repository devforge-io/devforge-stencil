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
import { contentCache } from "./cache.server";

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

export type AnyContentItem = ContentItem | PageItem | WikipediaItem;

// --- Draft branch (admin UI) ---

export async function listContent(): Promise<ContentListItem[]> {
  const [draftFiles, publishedFiles] = await Promise.all([
    listContentFiles(),
    listPublishedFiles(),
  ]);

  const publishedMap = new Map(
    publishedFiles.map((f) => [slugFromFilename(f.name), f.sha])
  );

  const items = await Promise.all(
    draftFiles.map(async (file) => {
      const slug = slugFromFilename(file.name);
      const cached = contentCache.getMeta(slug, file.sha);
      let meta: ContentFrontmatter;
      if (cached) {
        meta = cached;
      } else {
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

  return items
    .filter((item): item is ContentListItem => item !== null)
    .sort((a, b) => {
      const dateA = a.meta.publishedAt ?? "";
      const dateB = b.meta.publishedAt ?? "";
      return dateB.localeCompare(dateA);
    });
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

  const parsed = await parseMarkdown(file.content);
  contentCache.setFull(slug, file.sha, parsed);
  return { ...parsed, slug, sha: file.sha, contentType: "markdown" };
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

  contentCache.invalidate(slug);
}

export async function unpublishContent(slug: string, type: ContentType = "markdown"): Promise<void> {
  await unpublishFile(slug, type);
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

  const parsed = await parseMarkdown(file.content);
  contentCache.setFull(cacheKey, file.sha, parsed);
  return { ...parsed, slug, sha: file.sha, contentType: "markdown" };
}
