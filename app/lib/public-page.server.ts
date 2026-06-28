import { getPageCompiledCss, type AnyContentItem } from "./content.server";
import { renderHeaderImage } from "./page.server";

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

    head = `<script src="https://cdn.tailwindcss.com"><\/script><style>${css}</style>`;
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
