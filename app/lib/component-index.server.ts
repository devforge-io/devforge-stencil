import { getGitHubConfig, getRepoFileRaw, saveRepoFileRaw } from "./github.server";

/**
 * One entry in `components.json` — a lightweight index of every component so the
 * palette / admin list / API can enumerate them in a single read instead of
 * listing the components directory and reading each file. Components aren't
 * published, so this lives only on the draft branch.
 */
export interface ComponentIndexEntry {
  slug: string;
  name: string;
  category: string;
  icon?: string;
  description?: string;
  type?: "static" | "conditional";
  updatedAt: string;
}

function componentsIndexPath(): string {
  return `${getGitHubConfig().componentPath}/components.json`;
}

/** Read the components index (empty array if missing/malformed). */
export async function listComponentIndex(): Promise<ComponentIndexEntry[]> {
  const raw = await getRepoFileRaw(componentsIndexPath());
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.components)) return parsed.components;
    return [];
  } catch {
    return [];
  }
}

/** Whether the index file exists (distinguishes "empty" from "not created yet"). */
export async function componentIndexExists(): Promise<boolean> {
  return (await getRepoFileRaw(componentsIndexPath())) !== null;
}

export async function saveComponentIndex(list: ComponentIndexEntry[]): Promise<void> {
  const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
  await saveRepoFileRaw(componentsIndexPath(), JSON.stringify(sorted, null, 2), "Update components index");
}

/** Add or replace a component's entry (keyed by slug) and persist. */
export async function upsertComponentIndex(entry: ComponentIndexEntry): Promise<void> {
  const list = await listComponentIndex();
  const next = list.filter((c) => c.slug !== entry.slug);
  next.push(entry);
  await saveComponentIndex(next);
}

/** Drop a component from the index (on delete). No-op when absent. */
export async function removeFromComponentIndex(slug: string): Promise<void> {
  const list = await listComponentIndex();
  const next = list.filter((c) => c.slug !== slug);
  if (next.length === list.length) return;
  await saveComponentIndex(next);
}
