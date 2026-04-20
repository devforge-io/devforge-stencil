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

export type AnyContentItem = ContentItem | PageItem;

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
  // Try markdown first, then page
  let file = await getFileContent(slug, "markdown");
  let type: ContentType = "markdown";
  if (!file) {
    file = await getFileContent(slug, "page");
    type = "page";
  }
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

  const parsed = await parseMarkdown(file.content);
  contentCache.setFull(slug, file.sha, parsed);
  return { ...parsed, slug, sha: file.sha, contentType: "markdown" };
}

export async function saveContent(
  slug: string,
  raw: string,
  sha?: string,
  type: ContentType = "markdown"
): Promise<{ sha: string }> {
  const isNew = !sha;
  const message = isNew ? `Create ${slug}` : `Update ${slug}`;

  const result = await createOrUpdateFile(slug, raw, message, sha, type);
  contentCache.invalidate(slug);
  return result;
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

export async function getContentHistory(
  slug: string,
  type: ContentType = "markdown"
): Promise<ContentHistoryItem[]> {
  const [commits, publishedBlobSha] = await Promise.all([
    getFileHistory(slug, undefined, type),
    getPublishedFileSha(slug, type),
  ]);

  if (!publishedBlobSha) {
    return commits.map((c) => ({ ...c, isPublished: false }));
  }

  let foundPublished = false;
  const results: ContentHistoryItem[] = [];

  for (const commit of commits) {
    if (foundPublished) {
      results.push({ ...commit, isPublished: false });
      continue;
    }

    const blobSha = await getFileBlobShaAtCommit(slug, commit.sha, type);
    if (blobSha === publishedBlobSha) {
      results.push({ ...commit, isPublished: true });
      foundPublished = true;
    } else {
      results.push({ ...commit, isPublished: false });
    }
  }

  return results;
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
  return parseMarkdown(raw);
}

// --- Publish operations ---

export async function publishContent(slug: string, type: ContentType = "markdown"): Promise<void> {
  await publishFile(slug, type);
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
  let file = await getPublishedFileContent(slug, "markdown");
  let type: ContentType = "markdown";
  if (!file) {
    file = await getPublishedFileContent(slug, "page");
    type = "page";
  }
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

  const parsed = await parseMarkdown(file.content);
  contentCache.setFull(cacheKey, file.sha, parsed);
  return { ...parsed, slug, sha: file.sha, contentType: "markdown" };
}
