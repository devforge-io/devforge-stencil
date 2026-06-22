import {
  getPublishedContentByPath,
  getPageCompiledCss,
} from "~/lib/content.server";
import { renderHeaderImage } from "~/lib/page.server";
import type { Route } from "./+types/route";

// Paths owned by the app's own routes — never resolve a page for these.
const RESERVED_PREFIXES = [
  "/content",
  "/api",
  "/embed",
  "/login",
  "/logout",
  "/components",
  "/settings",
  "/.well-known",
];

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Public catch-all: serve a published page at its assigned `path` frontmatter.
 * This is a resource route (no component) — the loader returns the full HTML
 * document directly, so the page renders standalone at its custom URL.
 */
export async function loader({ params }: Route.LoaderArgs) {
  const path = "/" + (params["*"] ?? "").replace(/^\/+/, "");

  if (
    RESERVED_PREFIXES.some((p) => path === p || path.startsWith(p + "/"))
  ) {
    throw new Response("Not Found", { status: 404 });
  }

  const content = await getPublishedContentByPath(path);
  if (!content) {
    throw new Response("Not Found", { status: 404 });
  }

  const title = escapeHtml(content.frontmatter.title);
  const descTag = content.frontmatter.description
    ? `<meta name="description" content="${escapeHtml(content.frontmatter.description)}">`
    : "";
  const headerImage = renderHeaderImage(content.frontmatter.headerImage);

  let body: string;
  let head: string;

  if (content.contentType === "page") {
    // Prefer compiled CSS (publish branch, fall back to draft branch)
    let css = "css" in content ? (content as { css: string }).css : "";
    let compiled = await getPageCompiledCss(content.slug);
    if (!compiled) {
      const { getGitHubConfig } = await import("~/lib/github.server");
      compiled = await getPageCompiledCss(content.slug, getGitHubConfig().branch);
    }
    if (compiled) css = compiled;

    head = `<script src="https://cdn.tailwindcss.com"><\/script><style>${css}</style>`;
    body = `${headerImage}${content.html}`;
  } else {
    head = "";
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
