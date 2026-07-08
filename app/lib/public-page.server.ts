import { getPageCompiledCss, getPublishedContent, type AnyContentItem } from "./content.server";
import { renderHeaderImage } from "./page.server";
import { getSettings } from "./settings.server";
import { parseFragment } from "./dom.server";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatArticleDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric" }).format(d);
}

/** "Created … · Updated …" byline for a public article (Updated shown only when it differs). */
function renderArticleDates(createdAt: string | null, updatedAt: string | null): string {
  if (!createdAt) return "";
  const created = formatArticleDate(createdAt);
  if (!created) return "";
  const parts = [`Created <time datetime="${escapeHtml(createdAt)}">${escapeHtml(created)}</time>`];
  if (updatedAt && updatedAt !== createdAt) {
    const updated = formatArticleDate(updatedAt);
    if (updated) parts.push(`Updated <time datetime="${escapeHtml(updatedAt)}">${escapeHtml(updated)}</time>`);
  }
  return `<p class="pb-article-meta">${parts.join(" &middot; ")}</p>`;
}

// Cacheable by default; conditional/personalized pages opt out (see below).
// `s-maxage` is what a shared cache / CDN (e.g. Vercel's edge) uses — with only
// `max-age` the SSR output was cached in the browser but regenerated at the edge
// on every unique request. `max-age=0` keeps browsers revalidating (so a publish
// shows quickly) while the edge serves the cached HTML; `stale-while-revalidate`
// means users never block on a regeneration — the edge serves the last copy and
// refreshes in the background. Each full URL (incl. `?tag=`) caches separately.
const PUBLIC_CACHE =
  "public, max-age=0, s-maxage=360, stale-while-revalidate=86400";
const PRIVATE_CACHE = "private, no-store";

// Tailwind runtime for public pages. `darkMode:'media'` so the site's `dark:`
// body classes follow the visitor's OS preference (there's no toggle publicly).
const TAILWIND_HEAD = `<script src="https://cdn.tailwindcss.com"><\/script><script>tailwind.config={darkMode:'media'}<\/script>`;

/**
 * The page/template root element carries the site's body classes (the editor
 * bakes them onto it). Body classes belong on `<body>`, so remove ONLY those
 * tokens from the served root — they're applied to `<body>` instead. Any other
 * classes on the element (e.g. a component's own `flex …`) are preserved, so this
 * is safe even when the served root is a component rather than a page body. Also
 * makes a Settings change take effect on reload (the body class comes from
 * settings at render, not from the baked root).
 */
async function stripBodyClassesFromRoot(html: string, bodyClasses: string[]): Promise<string> {
  if (!bodyClasses.length || !html.trim()) return html;
  const doc = parseFragment(html);
  const root = doc.body.firstElementChild;
  if (root && root.getAttribute("class")) {
    const remove = new Set(bodyClasses);
    const kept = Array.from(root.classList).filter((c) => !remove.has(c));
    if (kept.length) root.setAttribute("class", kept.join(" "));
    else root.removeAttribute("class");
  }
  return doc.body.innerHTML;
}

// Page chrome for the DEFAULT (no-template) article layout only — a template page
// controls its own body/background.
const ARTICLE_PAGE_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #ffffff; color: #1a1a1a; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.7; }
@media (prefers-color-scheme: dark) { body { background: #0b0b0c; color: #e4e4e7; } }`;

// Typography for the article *body* (markdown-rendered HTML). Scoped to
// `.pb-article-body` so it applies whether the body sits in the default layout or
// inside a template's slot. Constrains media to the column; OS dark-mode aware.
const ARTICLE_BODY_CSS = `
.pb-article-body img, .pb-article-body video, .pb-article-body iframe { max-width: 100%; height: auto; }
.pb-article-body img[data-pb-header-image] { margin-bottom: 1rem; border-radius: 8px; }
.pb-article-body .pb-article-title { font-size: 2.25rem; line-height: 1.15; font-weight: 800; letter-spacing: -0.02em; margin: 0 0 1.25rem; }
.pb-article-body .pb-article-meta-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin: 0 0 2rem; }
.pb-article-body .pb-article-meta { margin: 0; font-size: 0.875rem; color: #71717a; }
.pb-article-body .pb-share-row { display: inline-flex; align-items: center; gap: 0.4rem; }
.pb-article-body .pb-share-btn { display: inline-flex; align-items: center; justify-content: center; width: 2rem; height: 2rem; border: 1px solid #e4e4e7; border-radius: 9999px; color: #52525b; background: transparent; cursor: pointer; text-decoration: none; transition: background .15s, color .15s, border-color .15s; }
.pb-article-body .pb-share-btn:hover { background: #f4f4f5; color: #18181b; }
.pb-article-body .pb-share-btn.copied { color: #16a34a; border-color: #16a34a; }
.pb-article-body .pb-share-btn svg { width: 1rem; height: 1rem; }
.pb-article-body .pb-article-actions { display: inline-flex; align-items: center; gap: 0.5rem; }
.pb-article-body .pb-edit-btn { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.8125rem; padding: 0.35rem 0.85rem; border: 1px solid #e4e4e7; border-radius: 9999px; color: #52525b; background: transparent; text-decoration: none; }
.pb-article-body .pb-edit-btn:hover { background: #f4f4f5; color: #18181b; }
.pb-article-body .pb-edit-btn[hidden] { display: none; }
.pb-article-body figure { margin: 1.5rem 0; }
.pb-article-body figure img { border-radius: 8px; }
.pb-article-body h1, .pb-article-body h2, .pb-article-body h3, .pb-article-body h4 { line-height: 1.25; margin: 1.75rem 0 0.75rem; }
.pb-article-body p { margin: 0 0 1rem; }
.pb-article-body a { color: #4f46e5; }
.pb-article-body pre { overflow-x: auto; background: #0d1117; color: #e6edf3; padding: 1rem; border-radius: 8px; }
.pb-article-body pre code { background: transparent; color: inherit; padding: 0; }
.pb-article-body code { font-family: ui-monospace, SFMono-Regular, monospace; }
.pb-article-body .hljs-comment, .pb-article-body .hljs-quote { color: #8b949e; font-style: italic; }
.pb-article-body .hljs-keyword, .pb-article-body .hljs-selector-tag, .pb-article-body .hljs-literal, .pb-article-body .hljs-doctag, .pb-article-body .hljs-formula { color: #ff7b72; }
.pb-article-body .hljs-string, .pb-article-body .hljs-meta .hljs-string, .pb-article-body .hljs-regexp { color: #a5d6ff; }
.pb-article-body .hljs-number, .pb-article-body .hljs-symbol, .pb-article-body .hljs-bullet, .pb-article-body .hljs-link { color: #79c0ff; }
.pb-article-body .hljs-title, .pb-article-body .hljs-title.class_, .pb-article-body .hljs-title.function_, .pb-article-body .hljs-section, .pb-article-body .hljs-name { color: #d2a8ff; }
.pb-article-body .hljs-attr, .pb-article-body .hljs-attribute, .pb-article-body .hljs-variable, .pb-article-body .hljs-template-variable, .pb-article-body .hljs-type, .pb-article-body .hljs-params, .pb-article-body .hljs-built_in, .pb-article-body .hljs-builtin-name { color: #ffa657; }
.pb-article-body .hljs-tag, .pb-article-body .hljs-selector-id, .pb-article-body .hljs-selector-class { color: #7ee787; }
.pb-article-body .hljs-meta { color: #79c0ff; }
.pb-article-body .hljs-deletion { color: #ffdcd7; background: #67060c; }
.pb-article-body .hljs-addition { color: #aff5b4; background: #033a16; }
.pb-article-body .hljs-emphasis { font-style: italic; }
.pb-article-body .hljs-strong { font-weight: 600; }
.pb-article-body blockquote { margin: 1.5rem 0; padding-left: 1rem; border-left: 3px solid #e4e4e7; color: #52525b; }
.pb-article-body hr { border: 0; border-top: 1px solid #e4e4e7; margin: 2rem 0; }
.pb-article-body table { width: 100%; border-collapse: collapse; display: block; overflow-x: auto; }
.pb-article-body th, .pb-article-body td { border: 1px solid #e4e4e7; padding: 0.5rem 0.75rem; text-align: left; }
@media (prefers-color-scheme: dark) {
  .pb-article-body a { color: #a5b4fc; }
  .pb-article-body .pb-article-meta { color: #a1a1aa; }
  .pb-article-body .pb-share-btn { border-color: #3f3f46; color: #a1a1aa; }
  .pb-article-body .pb-share-btn:hover { background: #27272a; color: #fafafa; }
  .pb-article-body .pb-edit-btn { border-color: #3f3f46; color: #a1a1aa; }
  .pb-article-body .pb-edit-btn:hover { background: #27272a; color: #fafafa; }
  .pb-article-body blockquote { border-left-color: #3f3f46; color: #a1a1aa; }
  .pb-article-body hr, .pb-article-body th, .pb-article-body td { border-color: #3f3f46; }
}`;

/**
 * Replace the article-content slot (`data-pb-article-slot`) in a template page's
 * HTML with the rendered article body. The slot element is removed and the body
 * takes its place, so the slot's editor-only preview styling is discarded.
 */
async function fillArticleSlot(templateHtml: string, articleBody: string): Promise<string> {
  const doc = parseFragment(templateHtml);
  const slot = doc.querySelector("[data-pb-article-slot]");
  if (!slot) return templateHtml;
  const tpl = doc.createElement("template");
  tpl.innerHTML = articleBody;
  slot.replaceWith(...Array.from(tpl.content.childNodes));
  return doc.body.innerHTML;
}

/**
 * OpenGraph + Twitter Card meta for social sharing. The image is the dedicated
 * `ogImage` (falling back to `headerImage`), resolved to an ABSOLUTE URL that
 * scrapers require; the request path (query stripped) is the canonical URL.
 * `og:site_name`, `og:image:alt`, and a description are included when available.
 */
function renderSocialMeta(
  content: AnyContentItem,
  opts: { request?: Request; siteName?: string; description?: string }
): string {
  const { request, siteName, description } = opts;
  const fm = content.frontmatter;
  const type = content.contentType === "article" ? "article" : "website";
  const tags: string[] = [`<meta property="og:type" content="${type}">`];

  if (siteName) tags.push(`<meta property="og:site_name" content="${escapeHtml(siteName)}">`);

  // Social overrides, falling back to the page title / meta description.
  const ogTitle = (typeof fm.ogTitle === "string" && fm.ogTitle.trim()) || fm.title;
  const ogDescription = (typeof fm.ogDescription === "string" && fm.ogDescription.trim()) || description;

  if (ogTitle) {
    tags.push(`<meta property="og:title" content="${escapeHtml(ogTitle)}">`);
    tags.push(`<meta name="twitter:title" content="${escapeHtml(ogTitle)}">`);
  }
  if (ogDescription) {
    tags.push(`<meta property="og:description" content="${escapeHtml(ogDescription)}">`);
    tags.push(`<meta name="twitter:description" content="${escapeHtml(ogDescription)}">`);
  }

  // Dedicated OpenGraph image, falling back to the header image.
  const rawImage = fm.ogImage || fm.headerImage;
  let image = "";
  if (rawImage) {
    try {
      image = request ? new URL(rawImage, request.url).toString() : rawImage;
    } catch {
      image = rawImage;
    }
  }
  if (image) {
    tags.push(`<meta property="og:image" content="${escapeHtml(image)}">`);
    tags.push(`<meta name="twitter:image" content="${escapeHtml(image)}">`);
    if (fm.title) tags.push(`<meta property="og:image:alt" content="${escapeHtml(fm.title)}">`);
  }

  if (request) {
    try {
      const u = new URL(request.url);
      tags.push(`<meta property="og:url" content="${escapeHtml(u.origin + u.pathname)}">`);
    } catch {
      /* ignore malformed URL */
    }
  }

  tags.push(`<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">`);
  return tags.join("\n  ");
}

/** Strip tags/entities/whitespace and trim to ~160 chars at a word boundary. */
function excerptFromHtml(html: string, max = 160): string {
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

/** The meta/social description: frontmatter description, else a body excerpt
 * (for text content — not pages, whose body is layout chrome). */
function metaDescription(content: AnyContentItem): string {
  const fm = content.frontmatter;
  if (typeof fm.description === "string" && fm.description.trim()) return fm.description.trim();
  if (content.contentType !== "page" && "html" in content && typeof content.html === "string") {
    return excerptFromHtml(content.html);
  }
  return "";
}

/** `<link rel="icon">` for the configured favicon, with a type hint by extension. */
function renderFaviconLink(favicon: unknown): string {
  if (typeof favicon !== "string" || !favicon.trim()) return "";
  const url = favicon.trim();
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  const type =
    ext === "svg" ? "image/svg+xml" : ext === "png" ? "image/png" : ext === "ico" ? "image/x-icon" : "";
  return `<link rel="icon"${type ? ` type="${type}"` : ""} href="${escapeHtml(url)}">`;
}

const SHARE_ICONS = {
  x: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/></svg>`,
  facebook: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>`,
  linkedin: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.225 0z"/></svg>`,
  instagram: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
};

// Copy the current URL to the clipboard, with a brief green "copied" state.
const SHARE_COPY_JS =
  "if(navigator.clipboard){navigator.clipboard.writeText(location.href);var b=this;b.classList.add('copied');setTimeout(function(){b.classList.remove('copied')},1500)}";

/**
 * A row of share buttons: X, Facebook, LinkedIn open the network's share URL;
 * Instagram and Copy copy the link (Instagram has no web share endpoint). Plain
 * links + inline handlers so it works on the static public page.
 */
function renderShareRow(url: string, title: string): string {
  if (!url) return "";
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(title);
  const link = (href: string, label: string, svg: string) =>
    `<a class="pb-share-btn" href="${href}" target="_blank" rel="noopener noreferrer" title="${label}" aria-label="${label}">${svg}</a>`;
  const copyBtn = (label: string, svg: string) =>
    `<button type="button" class="pb-share-btn" title="${label}" aria-label="${label}" onclick="${SHARE_COPY_JS}">${svg}</button>`;
  return (
    `<div class="pb-share-row">` +
    link(`https://twitter.com/intent/tweet?url=${u}&amp;text=${t}`, "Share on X", SHARE_ICONS.x) +
    link(`https://www.facebook.com/sharer/sharer.php?u=${u}`, "Share on Facebook", SHARE_ICONS.facebook) +
    link(`https://www.linkedin.com/sharing/share-offsite/?url=${u}`, "Share on LinkedIn", SHARE_ICONS.linkedin) +
    copyBtn("Copy link for Instagram", SHARE_ICONS.instagram) +
    copyBtn("Copy link", SHARE_ICONS.copy) +
    `</div>`
  );
}

/** An Edit link, hidden by default and revealed client-side (see the reveal
 * script) for signed-in CMS users, so the cached public HTML stays identical. */
function renderEditLink(slug: string): string {
  return (
    `<a id="pb-edit-link" class="pb-edit-btn" href="/content/${escapeHtml(slug)}/edit" hidden>` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>` +
    `<span>Edit</span></a>`
  );
}

// Reveals #pb-edit-link when /api/me reports a signed-in CMS role. Per-request
// (no-store), so it doesn't affect the shared/edge-cached page.
const EDIT_REVEAL_SCRIPT =
  `<script>fetch('/api/me',{headers:{accept:'application/json'}}).then(function(r){return r.ok?r.json():null}).then(function(d){if(d&&d.role){var e=document.getElementById('pb-edit-link');if(e){e.hidden=false}}}).catch(function(){});<\/script>`;

/**
 * Render a published content item as a full standalone HTML document Response.
 * Pages get the Tailwind runtime + their compiled CSS; other content types get
 * a basic <article> wrapper. Shared by the public splat route (custom paths)
 * and the root handler (a page assigned to "/").
 *
 * When `request` is provided and the page contains conditional-component
 * placeholders, branches are resolved server-side against the per-request
 * context. Such pages are served `private, no-store` so per-visitor markup is
 * never cached or shared.
 */
export async function renderPublicPageResponse(
  content: AnyContentItem,
  request?: Request
): Promise<Response> {
  // Site body classes, applied live at render (not baked per page).
  const { settings } = await getSettings();
  const bodyClassList = [...settings.bodyClasses, ...settings.darkBodyClasses];
  const bodyClass = bodyClassList.join(" ");

  const title = escapeHtml(content.frontmatter.title);
  // Falls back to an excerpt of the body so social/SEO snippets aren't blank.
  const description = metaDescription(content);
  const descTag = description
    ? `<meta name="description" content="${escapeHtml(description)}">`
    : "";
  const headerImage = renderHeaderImage(content.frontmatter.headerImage);
  const socialMeta = renderSocialMeta(content, {
    request,
    siteName: typeof settings.siteName === "string" ? settings.siteName : undefined,
    description,
  });

  let head = "";
  let body: string;
  let cacheControl = PUBLIC_CACHE;

  if (content.contentType === "page") {
    // Prefer compiled CSS (publish branch, fall back to draft branch)
    let css = "css" in content ? (content as { css: string }).css : "";
    let compiled = await getPageCompiledCss(content.slug);
    if (!compiled) {
      const { getGitHubConfig } = await import("./github.server");
      compiled = await getPageCompiledCss(content.slug, getGitHubConfig().branch);
    }
    if (compiled) css = compiled;

    body = `${headerImage}${await stripBodyClassesFromRoot(content.html, bodyClassList)}`;

    // Resolve any conditional-component placeholders server-side.
    if (request && body.includes("data-pb-conditional")) {
      const { resolveConditionals } = await import("./conditional/resolve.server");
      const result = await resolveConditionals(body, request, content);
      body = result.html;
      if (result.css) css += "\n" + result.css;
      if (result.resolved) cacheControl = PRIVATE_CACHE;
    }

    // Resolve article page-builder blocks (grid/card/featured/tags) from
    // articles.json. Runs after conditionals so blocks inside a chosen branch
    // are processed too. Only pages that include drafts drop to no-store; the
    // public cache is keyed per full URL, so `?tag=` variants cache separately.
    if (body.includes("data-pb-articles")) {
      const { resolveArticleBlocks } = await import("./articles/resolve.server");
      const result = await resolveArticleBlocks(body, request);
      body = result.html;
      if (result.css) css += "\n" + result.css;
      if (result.private) cacheControl = PRIVATE_CACHE;
    }

    head = `${TAILWIND_HEAD}<style>${css}</style>`;
  } else if (content.contentType === "article") {
    // Created/updated byline under the header image, from the published git
    // history (the live timeline): created = first publish, updated = latest.
    const { getContentDates, getGitHubConfig } = await import("./github.server");
    const dates = await getContentDates(content.slug, getGitHubConfig().publishBranch, "article").catch(
      () => ({ createdAt: null, updatedAt: null })
    );
    const meta = renderArticleDates(dates.createdAt, dates.updatedAt);
    const shareUrl = request ? (() => { const u = new URL(request.url); return u.origin + u.pathname; })() : "";
    const shareRow = renderShareRow(shareUrl, content.frontmatter.title);
    // Byline row: dates on the left; edit (CMS users only) + share on the right.
    const actions = `<div class="pb-article-actions">${renderEditLink(content.slug)}${shareRow}</div>`;
    const articleHead =
      `<h1 class="pb-article-title">${title}</h1>${headerImage}` +
      `<div class="pb-article-meta-row">${meta}${actions}</div>${EDIT_REVEAL_SCRIPT}`;
    const articleBody = `<div class="pb-article-body">${articleHead}${content.html}</div>`;
    const tplSlug = typeof settings.articleTemplateSlug === "string" ? settings.articleTemplateSlug : "";
    const template = tplSlug ? await getPublishedContent(tplSlug) : null;

    if (
      template &&
      template.contentType === "page" &&
      "html" in template &&
      (template.html as string).includes("data-pb-article-slot")
    ) {
      // Render the article inside the designated template page's layout.
      let css = ("css" in template ? (template as { css: string }).css : "") || (await getPageCompiledCss(tplSlug)) || "";
      if (!css) {
        const { getGitHubConfig } = await import("./github.server");
        css = (await getPageCompiledCss(tplSlug, getGitHubConfig().branch)) || "";
      }
      let tplBody = await stripBodyClassesFromRoot(await fillArticleSlot(template.html as string, articleBody), bodyClassList);

      // Resolve any page-builder placeholders the template contains.
      if (request && tplBody.includes("data-pb-conditional")) {
        const { resolveConditionals } = await import("./conditional/resolve.server");
        const r = await resolveConditionals(tplBody, request, content);
        tplBody = r.html;
        if (r.css) css += "\n" + r.css;
        if (r.resolved) cacheControl = PRIVATE_CACHE;
      }
      if (tplBody.includes("data-pb-articles")) {
        const { resolveArticleBlocks } = await import("./articles/resolve.server");
        const r = await resolveArticleBlocks(tplBody, request);
        tplBody = r.html;
        if (r.css) css += "\n" + r.css;
        if (r.private) cacheControl = PRIVATE_CACHE;
      }

      head = `${TAILWIND_HEAD}<style>${css}\n${ARTICLE_BODY_CSS}</style>`;
      body = tplBody;
    } else {
      // Default layout: centered ~800px column, media constrained, dark-mode aware.
      // Body classes (if any) sit on <body> and override the fallback chrome.
      head = `${TAILWIND_HEAD}<style>${ARTICLE_PAGE_CSS}${ARTICLE_BODY_CSS}</style>`;
      body = `<article class="pb-article-body" style="max-width:800px;margin:0 auto;padding:2rem 1.25rem;">${articleHead}${content.html}</article>`;
    }
  } else {
    head = TAILWIND_HEAD;
    body = `<article>${headerImage}${content.html}</article>`;
  }

  // Substitute {variables} in text (e.g. {username}) against the request context.
  // Runs last so tokens inside resolved conditional branches are also filled.
  if (request) {
    const { resolveTextVariables } = await import("./variables/resolve.server");
    const r = await resolveTextVariables(body, request, content);
    body = r.html;
    if (r.private) cacheControl = PRIVATE_CACHE;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  ${descTag}
  ${renderFaviconLink(settings.favicon)}
  ${socialMeta}
  ${head}
</head>
<body class="${bodyClass}">
  ${body}
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": cacheControl,
    },
  });
}
