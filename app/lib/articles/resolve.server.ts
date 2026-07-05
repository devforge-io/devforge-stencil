import { listArticleIndex, type ArticleIndexEntry } from "../articles.server";
import { listContent, listPublishedContent, type ContentListItem } from "../content.server";
import { parseFragment } from "../dom.server";

export interface ArticleResolveResult {
  html: string;
  /** Always "" — cards use Tailwind utilities, JIT-styled by the page's CDN. */
  css: string;
  /** True when the page actually contained an article block placeholder. */
  resolved: boolean;
  /** True when any block opted into drafts — caller drops the page to no-store. */
  private: boolean;
}

/**
 * Test seam. Production reads the authoritative published set from the publish
 * branch (`drafts:false`) or the draft branch's working set (`drafts:true`), so a
 * public page reflects what's actually published — not the draft-branch index.
 */
export interface ArticleResolveDeps {
  loadArticles?: (opts: { drafts: boolean }) => Promise<ArticleIndexEntry[]>;
}

type Variant = "grid" | "card" | "featured" | "tags";

interface ArticleBlockConfig {
  variant: Variant;
  count: number;
  tag: string | null;
  layout: "grid" | "list";
  columns: 2 | 3 | 4;
  drafts: "exclude" | "include";
  slug: string | null;
}

const MAX_TAGS_ON_CARD = 3;

/**
 * Resolve every `data-pb-articles` block placeholder in `html` by reading the
 * article index and swapping in server-rendered cards / grid / hero / tag chips.
 * Runs server-side so lists are SEO-friendly and drafts never leak to the client.
 */
export async function resolveArticleBlocks(
  html: string,
  request?: Request,
  deps?: ArticleResolveDeps
): Promise<ArticleResolveResult> {
  // Cheap string guard before paying for DOM parsing.
  if (!html.includes("data-pb-articles")) {
    return { html, css: "", resolved: false, private: false };
  }

  const doc = parseFragment(html);
  const placeholders = Array.from(doc.querySelectorAll("[data-pb-articles]"));
  if (placeholders.length === 0) {
    return { html, css: "", resolved: false, private: false };
  }

  // Load once per pass, per drafts mode — published-only and include-drafts read
  // different branches, so cache each independently.
  const loader = deps?.loadArticles ?? loadArticlesDefault;
  const cache = new Map<boolean, Promise<ArticleIndexEntry[]>>();
  const load = (drafts: boolean) => {
    if (!cache.has(drafts)) cache.set(drafts, loader({ drafts }));
    return cache.get(drafts)!;
  };

  const url = request ? new URL(request.url) : null;
  const queryTag = url?.searchParams.get("tag")?.trim() || null;
  const basePath = url?.pathname ?? "";

  let isPrivate = false;

  for (const el of placeholders) {
    const cfg = parseArticleConfig(el);
    const includeDrafts = cfg.drafts === "include";
    if (includeDrafts) isPrivate = true;

    // The source already scopes published vs all; being on the publish branch is
    // the "published" signal (the frontmatter draft flag doesn't hide it).
    const pool = await load(includeDrafts);
    const effectiveTag = queryTag ?? cfg.tag;

    let markup: string | null;
    if (cfg.variant === "tags") {
      markup = renderTags(pool, effectiveTag, basePath);
    } else {
      const list = filterArticles(pool, cfg, effectiveTag);
      if (cfg.variant === "card") markup = list[0] ? renderCard(list[0]) : null;
      else if (cfg.variant === "featured") markup = list[0] ? renderFeatured(list[0]) : null;
      else markup = renderGrid(list, cfg); // grid/list: renders an empty-state when list is empty
    }

    if (markup === null) {
      el.remove();
    } else {
      const tpl = doc.createElement("template");
      tpl.innerHTML = markup;
      el.replaceWith(...Array.from(tpl.content.childNodes));
    }
  }

  return { html: doc.body.innerHTML, css: "", resolved: true, private: isPrivate };
}

// --- data source -------------------------------------------------------------

/**
 * Production article source.
 * - Published (default): the `articles.json` manifest on the publish branch —
 *   maintained by `publishContent`/`unpublishContent`. Falls back to the actual
 *   published `.article` files if the manifest is missing/empty (e.g. articles
 *   published before the manifest existed), so nothing is silently dropped.
 * - Include drafts: the draft-branch manifest (all working articles), falling
 *   back to the draft content listing.
 */
async function loadArticlesDefault({ drafts }: { drafts: boolean }): Promise<ArticleIndexEntry[]> {
  if (drafts) {
    const manifest = await listArticleIndex();
    if (manifest.length) return manifest;
    return (await listContent()).filter((i) => i.contentType === "article").map(toEntry);
  }
  const { getGitHubConfig } = await import("../github.server");
  const manifest = await listArticleIndex(getGitHubConfig().publishBranch);
  if (manifest.length) return manifest;
  return (await listPublishedContent()).filter((i) => i.contentType === "article").map(toEntry);
}

function toEntry(i: ContentListItem): ArticleIndexEntry {
  return {
    slug: i.slug,
    title: i.meta.title,
    description: i.meta.description,
    tags: i.meta.tags,
    headerImage: i.meta.headerImage,
    publishedAt: i.meta.publishedAt,
    draft: i.meta.draft,
    updatedAt: i.meta.updatedAt ?? "",
  };
}

// --- config -----------------------------------------------------------------

function parseArticleConfig(el: Element): ArticleBlockConfig {
  const variant = (el.getAttribute("data-pb-articles") || "grid") as Variant;
  const defaultCount = variant === "grid" ? 6 : 1;
  const count = clamp(toInt(el.getAttribute("data-pb-count"), defaultCount), 1, 50);
  const tag = (el.getAttribute("data-pb-tag") || "").trim() || null;
  const layout = el.getAttribute("data-pb-layout") === "list" ? "list" : "grid";
  const cols = toInt(el.getAttribute("data-pb-columns"), 3);
  const columns = cols === 2 || cols === 4 ? cols : 3;
  const drafts = el.getAttribute("data-pb-drafts") === "include" ? "include" : "exclude";
  const slug = (el.getAttribute("data-pb-slug") || "").trim() || null;
  return { variant, count, tag, layout, columns, drafts, slug };
}

function filterArticles(
  articles: ArticleIndexEntry[],
  cfg: ArticleBlockConfig,
  tag: string | null
): ArticleIndexEntry[] {
  let list = articles;
  if (cfg.slug) list = list.filter((a) => a.slug === cfg.slug);
  if (tag) list = list.filter((a) => (a.tags ?? []).some((t) => t.toLowerCase() === tag.toLowerCase()));
  return [...list]
    .sort((a, b) => sortKey(b).localeCompare(sortKey(a)))
    .slice(0, cfg.count);
}

const sortKey = (a: ArticleIndexEntry) => a.publishedAt ?? a.updatedAt ?? "";

// --- renderers (Tailwind utilities; the page's Tailwind CDN styles them) -----

function renderCard(a: ArticleIndexEntry): string {
  return `<a href="/articles/${esc(a.slug)}" class="group block overflow-hidden rounded-lg border border-gray-200 bg-white no-underline transition hover:shadow-md dark:border-gray-800 dark:bg-gray-900">`
    + `<div class="aspect-[16/9] w-full overflow-hidden bg-gradient-to-br from-gray-100 to-gray-200 dark:from-gray-800 dark:to-gray-700">${cardImage(a)}</div>`
    + `<div class="p-5">`
    + `<h3 class="mb-2 text-lg font-semibold text-gray-900 group-hover:text-indigo-600 dark:text-white dark:group-hover:text-indigo-400">${esc(a.title)}</h3>`
    // All tags, under the title.
    + tagChips(a, undefined, Infinity)
    + description(a, "mb-3 line-clamp-2 text-sm text-gray-500 dark:text-gray-400")
    + dateEl(a, "text-xs text-gray-400 dark:text-gray-500")
    + `</div></a>`;
}

function renderListCard(a: ArticleIndexEntry): string {
  return `<a href="/articles/${esc(a.slug)}" class="group flex gap-5 py-5 no-underline">`
    + `<div class="aspect-[16/9] w-40 shrink-0 overflow-hidden rounded-lg bg-gradient-to-br from-gray-100 to-gray-200 dark:from-gray-800 dark:to-gray-700">${cardImage(a)}</div>`
    + `<div class="min-w-0 flex-1">${tagChips(a)}`
    + `<h3 class="mb-1 text-lg font-semibold text-gray-900 group-hover:text-indigo-600 dark:text-white dark:group-hover:text-indigo-400">${esc(a.title)}</h3>`
    + description(a, "mb-2 line-clamp-2 text-sm text-gray-500 dark:text-gray-400")
    + dateEl(a, "text-xs text-gray-400 dark:text-gray-500")
    + `</div></a>`;
}

function renderGrid(list: ArticleIndexEntry[], cfg: ArticleBlockConfig): string {
  if (list.length === 0) {
    return `<p class="py-8 text-center text-sm text-gray-400">No articles yet.</p>`;
  }
  if (cfg.layout === "list") {
    return `<div class="flex flex-col divide-y divide-gray-100">${list.map(renderListCard).join("")}</div>`;
  }
  const lg = cfg.columns === 2 ? "lg:grid-cols-2" : cfg.columns === 4 ? "lg:grid-cols-4" : "lg:grid-cols-3";
  return `<div class="grid grid-cols-1 sm:grid-cols-2 ${lg} gap-6">${list.map(renderCard).join("")}</div>`;
}

function renderFeatured(a: ArticleIndexEntry): string {
  const img = a.headerImage
    ? `<img src="${esc(a.headerImage)}" alt="" class="absolute inset-0 h-full w-full object-cover opacity-60 transition group-hover:opacity-70" />`
    : "";
  return `<a href="/articles/${esc(a.slug)}" class="group relative block overflow-hidden rounded-2xl bg-gray-900 text-white no-underline">${img}`
    + `<div class="relative z-10 flex min-h-[360px] flex-col justify-end p-8">${tagChips(a, "bg-white/15 text-white")}`
    + `<h2 class="mb-2 text-3xl font-bold sm:text-4xl">${esc(a.title)}</h2>`
    + description(a, "max-w-2xl text-white/80")
    + dateEl(a, "mt-3 text-sm text-white/60")
    + `</div></a>`;
}

function renderTags(articles: ArticleIndexEntry[], active: string | null, basePath: string): string {
  const tags = Array.from(new Set(articles.flatMap((a) => a.tags ?? []).map((t) => t.trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b));
  const chip = (label: string, href: string, on: boolean) =>
    `<a href="${esc(href)}" class="rounded-full border px-3 py-1 text-sm no-underline ${
      on ? "border-indigo-500 text-indigo-600" : "border-gray-200 text-gray-600 hover:border-gray-300"
    }">${esc(label)}</a>`;
  const chips = [chip("All", basePath || "?", !active)];
  for (const t of tags) {
    chips.push(chip(t, `${basePath}?tag=${encodeURIComponent(t)}`, !!active && t.toLowerCase() === active.toLowerCase()));
  }
  return `<div class="flex flex-wrap gap-2">${chips.join("")}</div>`;
}

// --- render helpers ----------------------------------------------------------

function cardImage(a: ArticleIndexEntry): string {
  return a.headerImage
    ? `<img src="${esc(a.headerImage)}" alt="" class="h-full w-full object-cover transition group-hover:scale-105" />`
    : "";
}

function tagChips(
  a: ArticleIndexEntry,
  cls = "bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300",
  limit = MAX_TAGS_ON_CARD
): string {
  const tags = (a.tags ?? []).slice(0, limit);
  if (tags.length === 0) return "";
  return `<div class="mb-2 flex flex-wrap gap-1.5">${tags
    .map((t) => `<span class="rounded-full px-2 py-0.5 text-xs font-medium ${cls}">${esc(t)}</span>`)
    .join("")}</div>`;
}

function description(a: ArticleIndexEntry, cls: string): string {
  return a.description ? `<p class="${cls}">${esc(a.description)}</p>` : "";
}

function dateEl(a: ArticleIndexEntry, cls: string): string {
  const label = formatDate(a.publishedAt);
  return label ? `<time class="${cls}" datetime="${esc(a.publishedAt ?? "")}">${esc(label)}</time>` : "";
}

// --- utilities ---------------------------------------------------------------

function toInt(value: string | null, fallback: number): number {
  const n = parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric" }).format(d);
}
