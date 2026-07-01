import { getArticlesIndexRaw, saveArticlesIndexRaw } from "./github.server";

/**
 * One entry in `articles.json` — a lightweight index of every `.article` so it
 * can be listed/consumed without reading each file. Kept in the content repo
 * alongside the articles themselves.
 */
export interface ArticleIndexEntry {
  slug: string;
  title: string;
  description?: string;
  tags?: string[];
  headerImage?: string;
  publishedAt?: string;
  draft?: boolean;
  /** When this index entry was last written. */
  updatedAt: string;
}

/**
 * Read the articles index (empty array if it doesn't exist or is malformed).
 * `branch` selects which branch's `articles.json` to read — omit for the draft
 * branch (the admin working manifest), pass the publish branch for the live one.
 */
export async function listArticleIndex(branch?: string): Promise<ArticleIndexEntry[]> {
  const raw = await getArticlesIndexRaw(branch);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.articles)) return parsed.articles;
    return [];
  } catch {
    return [];
  }
}

/** Add or replace an article's entry (keyed by slug) and persist the index. */
export async function upsertArticleIndex(entry: ArticleIndexEntry, branch?: string): Promise<void> {
  const list = await listArticleIndex(branch);
  const next = list.filter((a) => a.slug !== entry.slug);
  next.push(entry);
  next.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  await saveArticlesIndexRaw(JSON.stringify(next, null, 2), branch);
}

/** Drop an article from the index (e.g. when it's unpublished or deleted). */
export async function removeFromArticleIndex(slug: string, branch?: string): Promise<void> {
  const list = await listArticleIndex(branch);
  const next = list.filter((a) => a.slug !== slug);
  if (next.length === list.length) return; // nothing to do
  await saveArticlesIndexRaw(JSON.stringify(next, null, 2), branch);
}
