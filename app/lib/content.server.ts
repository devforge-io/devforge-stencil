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
  type GitHubCommit,
} from "./github.server";
import {
  parseMarkdown,
  parseFrontmatterOnly,
  type ContentFrontmatter,
  type ParsedContent,
} from "./markdown.server";
import { contentCache } from "./cache.server";

export interface ContentListItem {
  slug: string;
  meta: ContentFrontmatter;
  sha: string;
  published: boolean;
  upToDate: boolean;
}

export interface ContentItem extends ParsedContent {
  slug: string;
  sha: string;
}

function slugFromFilename(filename: string): string {
  return filename.replace(/\.md$/, "");
}

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
        const content = await getFileContent(slug);
        if (!content) return null;
        meta = parseFrontmatterOnly(content.content);
        contentCache.setMeta(slug, file.sha, meta);
      }

      const publishedSha = publishedMap.get(slug);
      return {
        slug,
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

export async function getContent(slug: string): Promise<ContentItem | null> {
  const file = await getFileContent(slug);
  if (!file) return null;

  const cached = contentCache.getFull(slug, file.sha);
  if (cached) {
    return { ...cached, slug, sha: file.sha };
  }

  const parsed = await parseMarkdown(file.content);
  contentCache.setFull(slug, file.sha, parsed);

  return { ...parsed, slug, sha: file.sha };
}

export async function saveContent(
  slug: string,
  raw: string,
  sha?: string
): Promise<{ sha: string }> {
  const isNew = !sha;
  const message = isNew ? `Create ${slug}` : `Update ${slug}`;

  const result = await createOrUpdateFile(slug, raw, message, sha);
  contentCache.invalidate(slug);
  return result;
}

export async function removeContent(
  slug: string,
  sha: string
): Promise<void> {
  await deleteFile(slug, sha, `Delete ${slug}`);
  contentCache.invalidate(slug);
}

export interface ContentHistoryItem extends GitHubCommit {
  isPublished: boolean;
}

export async function getContentHistory(
  slug: string
): Promise<ContentHistoryItem[]> {
  const [commits, publishedBlobSha] = await Promise.all([
    getFileHistory(slug),
    getPublishedFileSha(slug),
  ]);

  if (!publishedBlobSha) {
    return commits.map((c) => ({ ...c, isPublished: false }));
  }

  // Find which commit(s) match the published blob SHA.
  // Walk commits and check blob SHA until we find a match, then stop.
  let foundPublished = false;
  const results: ContentHistoryItem[] = [];

  for (const commit of commits) {
    if (foundPublished) {
      results.push({ ...commit, isPublished: false });
      continue;
    }

    const blobSha = await getFileBlobShaAtCommit(slug, commit.sha);
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
  commitSha: string
): Promise<ParsedContent | null> {
  const raw = await getFileAtCommit(slug, commitSha);
  if (!raw) return null;
  return parseMarkdown(raw);
}

// --- Publish operations ---

export async function publishContent(slug: string): Promise<void> {
  await publishFile(slug);
  contentCache.invalidate(slug);
}

export async function unpublishContent(slug: string): Promise<void> {
  await unpublishFile(slug);
  contentCache.invalidate(slug);
}

export async function getContentPublishStatus(slug: string) {
  return getPublishStatus(slug);
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
        const content = await getPublishedFileContent(slug);
        if (!content) return null;
        meta = parseFrontmatterOnly(content.content);
        contentCache.setMeta(`pub:${slug}`, file.sha, meta);
      }

      return {
        slug,
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
): Promise<ContentItem | null> {
  const file = await getPublishedFileContent(slug);
  if (!file) return null;

  const cacheKey = `pub:${slug}`;
  const cached = contentCache.getFull(cacheKey, file.sha);
  if (cached) {
    return { ...cached, slug, sha: file.sha };
  }

  const parsed = await parseMarkdown(file.content);
  contentCache.setFull(cacheKey, file.sha, parsed);

  return { ...parsed, slug, sha: file.sha };
}
