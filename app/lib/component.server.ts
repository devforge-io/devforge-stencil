import { getGitHubConfig } from "./github.server";
import { Octokit } from "octokit";
import type { ConditionalSpec } from "./conditional/types";
import {
  componentIndexExists,
  listComponentIndex,
  saveComponentIndex,
  upsertComponentIndex,
  removeFromComponentIndex,
} from "./component-index.server";

/** Static components are fixed markup; conditional components store a rule set. */
export type ComponentType = "static" | "conditional";

export interface ComponentMeta {
  slug: string;
  name: string;
  category: string;
  icon?: string;
  description?: string;
  /** Defaults to "static" when absent (legacy components). */
  type?: ComponentType;
}

export interface ComponentData extends ComponentMeta {
  html: string;
  css: string;
  projectData?: string;
  pages?: string[];
  /** Present on conditional components — the branch rule set. */
  spec?: ConditionalSpec;
  sha: string;
}

interface ComponentFile {
  meta: ComponentMeta;
  html: string;
  css: string;
  projectData?: string;
  /**
   * Slugs of pages that reference this component.
   * `undefined` = never indexed (triggers a lazy rebuild on first propagation).
   * `[]` = definitively no pages reference it.
   */
  pages?: string[];
  /** Present on conditional components — the branch rule set. */
  spec?: ConditionalSpec;
}

/**
 * The canonical placeholder markup for a conditional component. The page only
 * ever stores this lightweight node; the chosen branch's real markup is resolved
 * server-side at render time (see `conditional/resolve.server.ts`), so hidden
 * branches never reach the client. The dashed box makes it visible/selectable in
 * the editor — it is always replaced before serving.
 */
export function conditionalPlaceholderHtml(slug: string, name: string): string {
  const safeName = name.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<div data-pb-name="${safeName}" data-pb-conditional="${slug}" class="pb-conditional min-h-[40px] flex items-center justify-center gap-2 p-3 border-2 border-dashed border-indigo-400 rounded text-xs font-medium text-indigo-500"><span>&#10547; Conditional: ${safeName}</span></div>`;
}

function getOctokit(token: string) {
  return new Octokit({
    auth: token,
    request: { headers: { "X-GitHub-Api-Version": "2022-11-28" } },
  });
}

function componentFilePath(componentPath: string, slug: string): string {
  return `${componentPath}/${slug}.json`;
}

function cssFilePath(componentPath: string, slug: string): string {
  return `${componentPath}/${slug}.css`;
}

/**
 * List all components. Reads `components.json` in a single request. If the index
 * doesn't exist yet, it falls back to scanning the directory (slow) and
 * backfills the index so subsequent lists are fast.
 */
export async function listComponents(): Promise<ComponentMeta[]> {
  if (await componentIndexExists()) {
    const idx = await listComponentIndex();
    return idx.map((e) => ({
      slug: e.slug,
      name: e.name,
      category: e.category,
      icon: e.icon,
      description: e.description,
      type: e.type,
    }));
  }
  const scanned = await scanComponents();
  if (scanned.length > 0) {
    try {
      await saveComponentIndex(
        scanned.map((m) => ({
          slug: m.slug,
          name: m.name,
          category: m.category,
          icon: m.icon,
          description: m.description,
          type: m.type,
          updatedAt: new Date().toISOString(),
        }))
      );
    } catch (err) {
      console.error("[component] index backfill failed:", err);
    }
  }
  return scanned;
}

/** Directory scan of every component file (1 + N API calls) — the slow path. */
async function scanComponents(): Promise<ComponentMeta[]> {
  const config = getGitHubConfig();
  const octokit = getOctokit(config.token);

  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path: config.componentPath,
      ref: config.branch,
    });

    if (!Array.isArray(data)) return [];

    const jsonFiles = data.filter(
      (f) => f.type === "file" && f.name.endsWith(".json") && f.name !== "components.json"
    );

    const components: ComponentMeta[] = [];
    for (const file of jsonFiles) {
      try {
        const { data: fileData } = await octokit.rest.repos.getContent({
          owner: config.owner,
          repo: config.repo,
          path: file.path,
          ref: config.branch,
        });
        if (Array.isArray(fileData) || fileData.type !== "file") continue;
        const content = Buffer.from(fileData.content, "base64").toString("utf-8");
        const parsed: ComponentFile = JSON.parse(content);
        if (parsed?.meta?.slug) components.push(parsed.meta);
      } catch {
        // skip invalid files
      }
    }

    return components;
  } catch {
    return [];
  }
}

/**
 * Get a single component by slug.
 */
export async function getComponent(slug: string): Promise<ComponentData | null> {
  const config = getGitHubConfig();
  const octokit = getOctokit(config.token);
  const path = componentFilePath(config.componentPath, slug);

  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path,
      ref: config.branch,
    });

    if (Array.isArray(data) || data.type !== "file") return null;
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    const parsed: ComponentFile = JSON.parse(content);

    return {
      ...parsed.meta,
      html: parsed.html,
      css: parsed.css,
      projectData: parsed.projectData,
      pages: parsed.pages,
      spec: parsed.spec,
      sha: data.sha,
    };
  } catch {
    return null;
  }
}

/**
 * Internal: read the raw component file (including pages index) plus its sha.
 */
async function readComponentFile(
  slug: string
): Promise<{ file: ComponentFile; sha: string } | null> {
  const config = getGitHubConfig();
  const octokit = getOctokit(config.token);
  const path = componentFilePath(config.componentPath, slug);

  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path,
      ref: config.branch,
    });
    if (Array.isArray(data) || data.type !== "file") return null;
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    const file: ComponentFile = JSON.parse(content);
    return { file, sha: data.sha };
  } catch {
    return null;
  }
}

/**
 * Internal: write a complete ComponentFile to GitHub. Does NOT touch CSS or
 * trigger propagation — for use from index/metadata-only updates.
 */
async function writeComponentFile(
  slug: string,
  file: ComponentFile,
  sha: string | undefined,
  message: string
): Promise<{ sha: string }> {
  const config = getGitHubConfig();
  const octokit = getOctokit(config.token);
  const path = componentFilePath(config.componentPath, slug);
  const content = Buffer.from(JSON.stringify(file, null, 2)).toString("base64");

  const { data: result } = await octokit.rest.repos.createOrUpdateFileContents({
    owner: config.owner,
    repo: config.repo,
    path,
    message,
    content,
    branch: config.branch,
    ...(sha ? { sha } : {}),
  });

  return { sha: result.content?.sha ?? "" };
}

/**
 * Save (create or update) a component.
 */
export async function saveComponent(
  slug: string,
  data: {
    name: string;
    category: string;
    icon?: string;
    description?: string;
    html: string;
    css: string;
    projectData?: string;
    type?: ComponentType;
    spec?: ConditionalSpec;
  },
  sha?: string,
  options?: { excludePageSlug?: string }
): Promise<{ sha: string }> {
  // Preserve the existing pages index (and type/spec, which callers like the
  // visual editor don't resend) when rewriting the file.
  const existing = sha ? await readComponentFile(slug) : null;
  const existingSha = sha ?? existing?.sha;

  const type: ComponentType = data.type ?? existing?.file.meta.type ?? "static";
  const isConditional = type === "conditional";
  const spec = data.spec ?? existing?.file.spec;

  // A conditional component's body is always the canonical placeholder — its
  // logic lives in `spec`, not in markup.
  const html = isConditional ? conditionalPlaceholderHtml(slug, data.name) : data.html;

  const file: ComponentFile = {
    meta: {
      slug,
      name: data.name,
      category: data.category,
      icon: data.icon,
      description: data.description,
      type,
    },
    html,
    css: data.css,
    projectData: data.projectData,
    pages: existing?.file.pages,
    ...(isConditional ? { spec } : {}),
  };

  const result = await writeComponentFile(
    slug,
    file,
    existingSha,
    existingSha ? `Update component ${slug}` : `Create component ${slug}`
  );

  // Keep components.json in sync for fast listing (best-effort).
  try {
    await upsertComponentIndex({
      slug,
      name: data.name,
      category: data.category,
      icon: data.icon,
      description: data.description,
      type,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[component] index upsert failed for ${slug}:`, err);
  }

  // Best-effort cleanup of legacy <slug>.css file from the era when CSS
  // was stored separately. Safe to run repeatedly — once it's gone, this
  // is a no-op.
  await deleteLegacyComponentCss(slug).catch(() => {});

  // Update all pages that use this component. Conditional placeholders are
  // fixed, so they never need propagating — only spec changes, which are read
  // at render time.
  if (existingSha && !isConditional) {
    try {
      await propagateComponentUpdate(slug, html, options?.excludePageSlug);
    } catch (err) {
      console.error(`[component] Failed to propagate update for ${slug}:`, err);
    }
  }

  return { sha: result.sha };
}

/**
 * Delete a component.
 */
export async function deleteComponent(slug: string, sha: string): Promise<void> {
  const config = getGitHubConfig();
  const octokit = getOctokit(config.token);
  const path = componentFilePath(config.componentPath, slug);

  await octokit.rest.repos.deleteFile({
    owner: config.owner,
    repo: config.repo,
    path,
    message: `Delete component ${slug}`,
    sha,
    branch: config.branch,
  });

  // Keep components.json in sync (best-effort).
  try {
    await removeFromComponentIndex(slug);
  } catch (err) {
    console.error(`[component] index remove failed for ${slug}:`, err);
  }

  // Clean up legacy sidecar CSS file if present (from older saves)
  await deleteLegacyComponentCss(slug).catch(() => {});
}

/**
 * Remove the legacy <componentPath>/<slug>.css file if it exists.
 * Component CSS now lives inside the component's JSON file. This cleans up
 * the stale sidecar from older saves. Silent no-op if the file doesn't exist.
 */
async function deleteLegacyComponentCss(slug: string): Promise<void> {
  const config = getGitHubConfig();
  const octokit = getOctokit(config.token);
  const path = cssFilePath(config.componentPath, slug);

  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path,
      ref: config.branch,
    });
    if (Array.isArray(data) || data.type !== "file") return;
    await octokit.rest.repos.deleteFile({
      owner: config.owner,
      repo: config.repo,
      path,
      message: `Remove legacy component CSS ${slug}`,
      sha: data.sha,
      branch: config.branch,
    });
  } catch {
    // not present — nothing to do
  }
}

/**
 * Propagate a component update to all pages that use it.
 * Uses the component's stored `pages` index when present, falling back to a
 * one-time full scan to populate it. Self-heals drift (pages that no longer
 * reference the slug, or have been deleted) by culling stale index entries.
 */
async function propagateComponentUpdate(slug: string, _newHtml: string, excludePageSlug?: string): Promise<void> {
  const { getFileContent, createOrUpdateFile } = await import("./github.server");
  const { parsePage, buildPageRaw } = await import("./page.server");
  const { renderToHtml } = await import("./page-builder/serializer");

  const component = await getComponent(slug);
  if (!component?.projectData) {
    console.log(`[component] No projectData stored for "${slug}", skipping propagation`);
    return;
  }

  // Lazy migration: legacy components have no `pages` field. Rebuild once.
  if (component.pages === undefined) {
    console.log(`[component] No pages index for "${slug}" — rebuilding`);
    await rebuildComponentIndex(slug).catch((err) => {
      console.error(`[component] Failed to rebuild index for "${slug}":`, err);
    });
  }

  // Reload to pick up rebuilt index (or empty array if rebuild failed)
  const fresh = await getComponent(slug);
  const pages = fresh?.pages ?? [];

  let componentProject: { root?: { children?: unknown[] } };
  try {
    componentProject = JSON.parse(component.projectData);
  } catch {
    console.error(`[component] Invalid projectData JSON for "${slug}"`);
    return;
  }

  const componentRoot = componentProject.root;
  const newComponentNode = componentRoot?.children?.[0] as Record<string, unknown> | undefined;
  if (!newComponentNode) {
    console.log(`[component] Component "${slug}" has no root node in projectData`);
    return;
  }
  if (!newComponentNode.attributes) newComponentNode.attributes = {};
  (newComponentNode.attributes as Record<string, string>)["data-pb-component"] = slug;

  console.log(`[component] Propagating "${slug}" to ${pages.length} indexed page(s)`);

  const drifted: string[] = [];

  for (const pageSlug of pages) {
    if (excludePageSlug && pageSlug === excludePageSlug) continue;

    const fileData = await getFileContent(pageSlug, "page");
    if (!fileData) {
      // Page deleted out from under us — cull from index
      drifted.push(pageSlug);
      continue;
    }

    if (!fileData.content.includes(slug)) {
      // Page no longer references this component — cull from index
      drifted.push(pageSlug);
      continue;
    }

    const parsed = parsePage(fileData.content);
    let projectObj: Record<string, unknown>;
    try {
      projectObj = JSON.parse(parsed.projectData);
    } catch {
      continue;
    }

    const root = projectObj.root as Record<string, unknown> | undefined;
    if (!root) continue;

    let modified = false;
    const replaceNodes = (node: Record<string, unknown>) => {
      const children = node.children as Record<string, unknown>[] | undefined;
      if (!children) return;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const attrs = child.attributes as Record<string, string> | undefined;
        if (attrs && attrs["data-pb-component"] === slug) {
          const oldId = child.id as string;
          const replacement = JSON.parse(JSON.stringify(newComponentNode));
          replacement.id = oldId;
          children[i] = replacement;
          modified = true;
        } else {
          replaceNodes(child);
        }
      }
    };
    replaceNodes(root);

    if (!modified) {
      // Index claimed this page references the component, but the tree
      // has no matching nodes. Cull.
      drifted.push(pageSlug);
      continue;
    }

    const rootChildren = (root as { children: unknown[] }).children;
    const updatedHtml = rootChildren.map((child) => renderToHtml(child as never)).join("");
    const updatedProject = JSON.stringify(projectObj, null, 2);

    const matter = await import("gray-matter");
    const { data: fm } = matter.default(fileData.content);
    fm.updatedAt = new Date().toISOString();
    const newRaw = buildPageRaw(fm, updatedProject, updatedHtml, parsed.css);

    await createOrUpdateFile(pageSlug, newRaw, `Update component ${slug} in ${pageSlug}`, fileData.sha, "page");
    console.log(`[component] Saved "${pageSlug}" with updated "${slug}"`);
  }

  // Cull drift quietly — best-effort, don't block on failure
  for (const orphan of drifted) {
    await updateComponentPagesIndex(slug, orphan, "remove").catch((err) => {
      console.error(`[component] Failed to cull "${orphan}" from "${slug}" index:`, err);
    });
  }
}

/**
 * Add or remove a page slug from a component's `pages` index. Idempotent.
 * Retries on GitHub SHA conflicts (409) to handle concurrent writers.
 */
export async function updateComponentPagesIndex(
  componentSlug: string,
  pageSlug: string,
  action: "add" | "remove"
): Promise<void> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const existing = await readComponentFile(componentSlug);
    if (!existing) return; // component file gone — nothing to update

    const current = new Set(existing.file.pages ?? []);
    const had = current.has(pageSlug);
    if (action === "add") {
      if (had) return; // already indexed
      current.add(pageSlug);
    } else {
      if (!had) return; // already absent
      current.delete(pageSlug);
    }

    const next: ComponentFile = {
      ...existing.file,
      pages: Array.from(current).sort(),
    };

    try {
      await writeComponentFile(
        componentSlug,
        next,
        existing.sha,
        `Index ${action} page ${pageSlug} → component ${componentSlug}`
      );
      return;
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      if (status !== 409 || attempt === MAX_ATTEMPTS - 1) throw err;
      // SHA conflict — back off and retry with fresh sha
      await new Promise((r) => setTimeout(r, 50 * Math.pow(2, attempt)));
    }
  }
}

/**
 * Walk a page project's PBNode tree and return the unique set of
 * data-pb-component slugs it references.
 */
export function scanProjectForComponentSlugs(projectDataJson: string): Set<string> {
  const found = new Set<string>();
  if (!projectDataJson) return found;

  let project: { root?: RawNode };
  try {
    project = JSON.parse(projectDataJson);
  } catch {
    return found;
  }
  if (!project.root) return found;

  const walk = (node: RawNode) => {
    const slug = node.attributes?.["data-pb-component"];
    if (slug) {
      found.add(slug);
      // Don't descend into a component's interior — nested inner refs
      // belong to the parent component definition.
      return;
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child);
    }
  };
  walk(project.root);
  return found;
}

/**
 * Recompute a single component's `pages` index by scanning every .page file.
 * Use to recover from drift or for one-time migration.
 */
export async function rebuildComponentIndex(componentSlug: string): Promise<void> {
  const { listContentFiles, getFileContent } = await import("./github.server");
  const { parsePage } = await import("./page.server");

  const existing = await readComponentFile(componentSlug);
  if (!existing) return;

  const files = await listContentFiles();
  const pageFiles = files.filter((f) => f.contentType === "page");

  const matched: string[] = [];
  for (const file of pageFiles) {
    const pageSlug = file.name.replace(".page", "");
    const fileData = await getFileContent(pageSlug, "page");
    if (!fileData) continue;
    if (!fileData.content.includes(componentSlug)) continue;

    const parsed = parsePage(fileData.content);
    const slugs = scanProjectForComponentSlugs(parsed.projectData);
    if (slugs.has(componentSlug)) matched.push(pageSlug);
  }

  matched.sort();
  const next: ComponentFile = { ...existing.file, pages: matched };
  await writeComponentFile(
    componentSlug,
    next,
    existing.sha,
    `Rebuild pages index for component ${componentSlug}`
  );
  console.log(`[component] Rebuilt index for "${componentSlug}": ${matched.length} page(s)`);
}

/**
 * Recompute every component's `pages` index in a single pass over all pages.
 * Cheaper than calling rebuildComponentIndex for each component when many
 * exist. Use for full repair.
 */
export async function rebuildAllComponentIndices(): Promise<void> {
  const { listContentFiles, getFileContent } = await import("./github.server");
  const { parsePage } = await import("./page.server");

  const components = await listComponents();
  if (components.length === 0) return;
  const componentSlugs = new Set(components.map((c) => c.slug));

  const refsByComponent = new Map<string, string[]>();
  for (const slug of componentSlugs) refsByComponent.set(slug, []);

  const files = await listContentFiles();
  const pageFiles = files.filter((f) => f.contentType === "page");

  for (const file of pageFiles) {
    const pageSlug = file.name.replace(".page", "");
    const fileData = await getFileContent(pageSlug, "page");
    if (!fileData) continue;

    const parsed = parsePage(fileData.content);
    const slugs = scanProjectForComponentSlugs(parsed.projectData);
    for (const slug of slugs) {
      if (componentSlugs.has(slug)) refsByComponent.get(slug)!.push(pageSlug);
    }
  }

  for (const [slug, pages] of refsByComponent) {
    const existing = await readComponentFile(slug);
    if (!existing) continue;
    pages.sort();
    const next: ComponentFile = { ...existing.file, pages };
    await writeComponentFile(slug, next, existing.sha, `Rebuild pages index for component ${slug}`);
  }
  console.log(`[component] Rebuilt all component indices (${componentSlugs.size} component(s), ${pageFiles.length} page(s))`);
}

type RawNode = {
  id?: string;
  attributes?: Record<string, string>;
  children?: RawNode[];
  [key: string]: unknown;
};

/**
 * Walk a PBNode tree and return the first subtree found for each unique
 * data-pb-component slug.
 */
function collectComponentSubtrees(root: RawNode): Map<string, RawNode> {
  const found = new Map<string, RawNode>();
  const walk = (node: RawNode) => {
    const slug = node.attributes?.["data-pb-component"];
    if (slug && !found.has(slug)) {
      found.set(slug, node);
      // Don't descend into a component subtree — its inner nodes belong to it
      return;
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child);
    }
  };
  walk(root);
  return found;
}

/**
 * Produce a deterministic fingerprint of a node tree, ignoring instance IDs.
 */
function nodeFingerprint(node: RawNode | undefined): string {
  if (!node) return "";
  const strip = (n: RawNode): RawNode => {
    const { id: _id, ...rest } = n;
    return {
      ...rest,
      children: Array.isArray(n.children) ? n.children.map(strip) : [],
    };
  };
  return JSON.stringify(strip(node));
}

/**
 * After a page is saved, find every data-pb-component subtree in its project
 * and, for any whose contents differ from the stored component definition,
 * update the component (which propagates to all other pages).
 */
export async function syncComponentsFromPageProject(
  pageSlug: string,
  projectDataJson: string
): Promise<void> {
  if (!projectDataJson) return;

  let project: { root?: RawNode };
  try {
    project = JSON.parse(projectDataJson);
  } catch {
    return;
  }
  if (!project.root) return;

  const { renderToHtml } = await import("./page-builder/serializer");

  const subtrees = collectComponentSubtrees(project.root);

  // Ensure every referenced component knows this page references it
  // (idempotent — no-op if already indexed).
  for (const slug of subtrees.keys()) {
    await updateComponentPagesIndex(slug, pageSlug, "add").catch((err) => {
      console.error(`[component] Failed to index page "${pageSlug}" → "${slug}":`, err);
    });
  }

  for (const [slug, pageNode] of subtrees) {
    try {
      const existing = await getComponent(slug);
      if (!existing) continue;

      let existingProject: { root?: RawNode } = {};
      try {
        existingProject = existing.projectData ? JSON.parse(existing.projectData) : {};
      } catch {
        existingProject = {};
      }
      const existingNode = existingProject.root?.children?.[0];

      if (nodeFingerprint(existingNode) === nodeFingerprint(pageNode)) continue;

      const newProject = {
        version: 1,
        ...(existingProject ?? {}),
        root: {
          ...(existingProject.root ?? { id: "pb-root", tag: "div", type: "element", classes: [], styles: {}, attributes: {} }),
          children: [pageNode],
        },
      };

      const newHtml = renderToHtml(pageNode as never);

      await saveComponent(
        slug,
        {
          name: existing.name,
          category: existing.category,
          icon: existing.icon,
          description: existing.description,
          html: newHtml,
          css: existing.css,
          projectData: JSON.stringify(newProject),
        },
        existing.sha,
        { excludePageSlug: pageSlug }
      );
      console.log(`[component] Synced "${slug}" from page "${pageSlug}"`);
    } catch (err) {
      console.error(`[component] Failed to sync "${slug}" from page "${pageSlug}":`, err);
    }
  }
}

/**
 * Remove a page slug from every component's `pages` index. Call before/after
 * deleting a page so component indices don't accumulate dead references.
 * Best-effort — failures are logged, never thrown.
 */
export async function removePageFromAllComponentIndices(pageSlug: string): Promise<void> {
  const components = await listComponents();
  for (const c of components) {
    await updateComponentPagesIndex(c.slug, pageSlug, "remove").catch((err) => {
      console.error(`[component] Failed to remove "${pageSlug}" from "${c.slug}" index:`, err);
    });
  }
}

/**
 * Get compiled CSS for a component. Reads from the component's JSON file.
 */
export async function getComponentCss(slug: string): Promise<string | null> {
  const component = await getComponent(slug);
  return component?.css ?? null;
}
