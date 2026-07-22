import { getGitHubConfig, getRepoFileRaw, saveRepoFileRaw } from "./github.server";

/**
 * One entry in `pages.json` — a lightweight index of every `.page` so pages can
 * be listed without reading each file. Kept alongside the content, on both the
 * draft branch (all pages) and the publish branch (published only).
 */
export interface PageIndexEntry {
  slug: string;
  title: string;
  description?: string;
  tags?: string[];
  /** Custom public URL path, if assigned. */
  path?: string;
  publishedAt?: string;
  draft?: boolean;
  updatedAt: string;
}

function pagesIndexPath(): string {
  return `${getGitHubConfig().contentPath}/pages.json`;
}

/** Read the pages index (empty array if missing/malformed). */
export async function listPageIndex(branch?: string): Promise<PageIndexEntry[]> {
  const raw = await getRepoFileRaw(pagesIndexPath(), branch);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.pages)) return parsed.pages;
    return [];
  } catch {
    return [];
  }
}

/** Whether the index file exists (distinguishes "empty" from "not created yet"). */
export async function pageIndexExists(branch?: string): Promise<boolean> {
  return (await getRepoFileRaw(pagesIndexPath(), branch)) !== null;
}

export async function savePageIndex(list: PageIndexEntry[], branch?: string): Promise<void> {
  await saveRepoFileRaw(pagesIndexPath(), JSON.stringify(list, null, 2), "Update pages index", branch);
}

/** Add or replace a page's entry (keyed by slug) and persist. */
export async function upsertPageIndex(entry: PageIndexEntry, branch?: string): Promise<void> {
  const list = await listPageIndex(branch);
  const next = list.filter((p) => p.slug !== entry.slug);
  next.push(entry);
  next.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  await savePageIndex(next, branch);
}

/** Drop a page from the index (delete/unpublish). No-op when absent. */
export async function removeFromPageIndex(slug: string, branch?: string): Promise<void> {
  const list = await listPageIndex(branch);
  const next = list.filter((p) => p.slug !== slug);
  if (next.length === list.length) return;
  await savePageIndex(next, branch);
}
