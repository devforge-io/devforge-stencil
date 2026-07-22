import { getGitHubConfig, getRepoFileRaw, saveRepoFileRaw } from "./github.server";

/**
 * One entry in `tutorial.json` — a lightweight index of every `.tutorial` (with
 * a chapter summary) so tutorials can be listed without reading each file. Kept
 * on the draft branch (all tutorials) and the publish branch (published only).
 */
export interface TutorialIndexEntry {
  slug: string;
  title: string;
  description?: string;
  tags?: string[];
  publishedAt?: string;
  draft?: boolean;
  /** Ordered chapter summary (slug + title). */
  chapters?: { slug: string; title: string }[];
  updatedAt: string;
}

function tutorialIndexPath(): string {
  return `${getGitHubConfig().contentPath}/tutorial.json`;
}

/** Read the tutorial index (empty array if missing/malformed). */
export async function listTutorialIndex(branch?: string): Promise<TutorialIndexEntry[]> {
  const raw = await getRepoFileRaw(tutorialIndexPath(), branch);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.tutorials)) return parsed.tutorials;
    return [];
  } catch {
    return [];
  }
}

/** Whether the index file exists (distinguishes "empty" from "not created yet"). */
export async function tutorialIndexExists(branch?: string): Promise<boolean> {
  return (await getRepoFileRaw(tutorialIndexPath(), branch)) !== null;
}

export async function saveTutorialIndex(list: TutorialIndexEntry[], branch?: string): Promise<void> {
  await saveRepoFileRaw(tutorialIndexPath(), JSON.stringify(list, null, 2), "Update tutorial index", branch);
}

/** Add or replace a tutorial's entry (keyed by slug) and persist. */
export async function upsertTutorialIndex(entry: TutorialIndexEntry, branch?: string): Promise<void> {
  const list = await listTutorialIndex(branch);
  const next = list.filter((t) => t.slug !== entry.slug);
  next.push(entry);
  next.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  await saveTutorialIndex(next, branch);
}

/** Drop a tutorial from the index (delete/unpublish). No-op when absent. */
export async function removeFromTutorialIndex(slug: string, branch?: string): Promise<void> {
  const list = await listTutorialIndex(branch);
  const next = list.filter((t) => t.slug !== slug);
  if (next.length === list.length) return;
  await saveTutorialIndex(next, branch);
}
