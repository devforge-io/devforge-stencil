import { getPageCompiledCss, type AnyContentItem } from "./content.server";
import { renderHeaderImage } from "./page.server";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render a published content item as a full standalone HTML document Response.
 * Pages get the Tailwind runtime + their compiled CSS; other content types get
 * a basic <article> wrapper. Shared by the public splat route (custom paths)
 * and the root handler (a page assigned to "/").
 */
export async function renderPublicPageResponse(
  content: AnyContentItem
): Promise<Response> {
  const title = escapeHtml(content.frontmatter.title);
  const descTag = content.frontmatter.description
    ? `<meta name="description" content="${escapeHtml(content.frontmatter.description)}">`
    : "";
  const headerImage = renderHeaderImage(content.frontmatter.headerImage);

  let head = "";
  let body: string;

  if (content.contentType === "page") {
    // Prefer compiled CSS (publish branch, fall back to draft branch)
    let css = "css" in content ? (content as { css: string }).css : "";
    let compiled = await getPageCompiledCss(content.slug);
    if (!compiled) {
      const { getGitHubConfig } = await import("./github.server");
      compiled = await getPageCompiledCss(content.slug, getGitHubConfig().branch);
    }
    if (compiled) css = compiled;

    head = `<script src="https://cdn.tailwindcss.com"><\/script><style>${css}</style>`;
    body = `${headerImage}${content.html}`;
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
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
    },
  });
}
