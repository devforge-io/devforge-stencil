import { getPageCompiledCss, getPublishedContent, type AnyContentItem } from "./content.server";
import { renderHeaderImage } from "./page.server";
import { getSettings } from "./settings.server";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Cacheable by default; conditional pages opt out (see below).
const PUBLIC_CACHE = "public, max-age=60, stale-while-revalidate=300";
const PRIVATE_CACHE = "private, no-store";

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
.pb-article-body img[data-pb-header-image] { margin-bottom: 2rem; border-radius: 8px; }
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
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(`<!DOCTYPE html><body>${templateHtml}</body>`);
  const doc = dom.window.document;
  const slot = doc.querySelector("[data-pb-article-slot]");
  if (!slot) return templateHtml;
  const tpl = doc.createElement("template");
  tpl.innerHTML = articleBody;
  slot.replaceWith(...Array.from(tpl.content.childNodes));
  return doc.body.innerHTML;
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
  const title = escapeHtml(content.frontmatter.title);
  const descTag = content.frontmatter.description
    ? `<meta name="description" content="${escapeHtml(content.frontmatter.description)}">`
    : "";
  const headerImage = renderHeaderImage(content.frontmatter.headerImage);

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

    body = `${headerImage}${content.html}`;

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

    head = `<script src="https://cdn.tailwindcss.com"><\/script><style>${css}</style>`;
  } else if (content.contentType === "article") {
    const articleBody = `<div class="pb-article-body">${headerImage}${content.html}</div>`;
    const { settings } = await getSettings();
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
      let tplBody = await fillArticleSlot(template.html as string, articleBody);

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

      head = `<script src="https://cdn.tailwindcss.com"><\/script><style>${css}\n${ARTICLE_BODY_CSS}</style>`;
      body = tplBody;
    } else {
      // Default layout: centered ~800px column, media constrained, dark-mode aware.
      head = `<style>${ARTICLE_PAGE_CSS}${ARTICLE_BODY_CSS}</style>`;
      body = `<article class="pb-article-body" style="max-width:800px;margin:0 auto;padding:2rem 1.25rem;">${headerImage}${content.html}</article>`;
    }
  } else {
    body = `<article>${headerImage}${content.html}</article>`;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  ${descTag}
  ${head}
</head>
<body>
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
