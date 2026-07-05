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

// Cacheable by default; conditional pages opt out (see below).
const PUBLIC_CACHE = "public, max-age=60, stale-while-revalidate=300";
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
.pb-article-body .pb-article-meta { margin: 0 0 2rem; font-size: 0.875rem; color: #71717a; }
.pb-article-body figure { margin: 1.5rem 0; }
.pb-article-body figure img { border-radius: 8px; }
.pb-article-body h1, .pb-article-body h2, .pb-article-body h3, .pb-article-body h4 { line-height: 1.25; margin: 1.75rem 0 0.75rem; }
.pb-article-body p { margin: 0 0 1rem; }
.pb-article-body a { color: #4f46e5; }
.pb-article-body pre { overflow-x: auto; background: #f4f4f5; padding: 1rem; border-radius: 8px; }
.pb-article-body code { font-family: ui-monospace, SFMono-Regular, monospace; }
.pb-article-body blockquote { margin: 1.5rem 0; padding-left: 1rem; border-left: 3px solid #e4e4e7; color: #52525b; }
.pb-article-body hr { border: 0; border-top: 1px solid #e4e4e7; margin: 2rem 0; }
.pb-article-body table { width: 100%; border-collapse: collapse; display: block; overflow-x: auto; }
.pb-article-body th, .pb-article-body td { border: 1px solid #e4e4e7; padding: 0.5rem 0.75rem; text-align: left; }
@media (prefers-color-scheme: dark) {
  .pb-article-body a { color: #a5b4fc; }
  .pb-article-body .pb-article-meta { color: #a1a1aa; }
  .pb-article-body pre { background: #18181b; }
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
    const articleBody = `<div class="pb-article-body">${headerImage}${meta}${content.html}</div>`;
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
      body = `<article class="pb-article-body" style="max-width:800px;margin:0 auto;padding:2rem 1.25rem;">${headerImage}${meta}${content.html}</article>`;
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
