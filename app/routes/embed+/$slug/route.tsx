import { getPublishedContent } from "~/lib/content.server";
import { requireApiToken } from "~/lib/auth.server";
import type { Route } from "./+types/route";

const EMBED_STYLES = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    line-height: 1.6;
    color: #1a1a1a;
    padding: 1.5rem;
  }
  h1 { font-size: 1.875rem; font-weight: 700; margin-bottom: 1rem; margin-top: 1.5rem; }
  h2 { font-size: 1.5rem; font-weight: 600; margin-bottom: 0.75rem; margin-top: 1.25rem; }
  h3 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; margin-top: 1rem; }
  p { margin-bottom: 1rem; }
  ul, ol { padding-left: 1.5rem; margin-bottom: 1rem; }
  li { margin-bottom: 0.25rem; }
  code { background: #f4f4f5; padding: 0.125rem 0.375rem; border-radius: 0.25rem; font-size: 0.875rem; }
  pre { background: #18181b; color: #e4e4e7; padding: 1rem; border-radius: 0.5rem; overflow-x: auto; margin-bottom: 1rem; }
  pre code { background: transparent; padding: 0; }
  blockquote { border-left: 3px solid #4c6ef5; padding-left: 1rem; font-style: italic; color: #6b7280; margin-bottom: 1rem; }
  a { color: #4c6ef5; text-decoration: underline; }
  img { max-width: 100%; border-radius: 0.5rem; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; }
  th, td { border: 1px solid #e5e7eb; padding: 0.5rem 0.75rem; text-align: left; }
  th { background: #f9fafb; font-weight: 600; }
  hr { margin: 2rem 0; border: none; border-top: 1px solid #e5e7eb; }
`;

export async function loader({ params, request }: Route.LoaderArgs) {
  const denied = requireApiToken(request);
  if (denied) return denied;

  const content = await getPublishedContent(params.slug);
  if (!content) {
    return new Response("Not found", { status: 404 });
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(content.frontmatter.title)}</title>
  ${content.contentType === "page" ? `<script src="https://cdn.tailwindcss.com"><\/script>` : ""}
  <style>${content.contentType === "page" && "css" in content ? (content as { css: string }).css : EMBED_STYLES}</style>
</head>
<body class="stencil-embed">
  ${content.contentType === "page" ? content.html : `<article>${content.html}</article>`}
  <script>
    // Auto-resize for iframe embedding
    function notifySize() {
      window.parent.postMessage({
        type: 'stencil-resize',
        slug: '${params.slug}',
        height: document.body.scrollHeight
      }, '*');
    }
    window.addEventListener('load', notifySize);
    new ResizeObserver(notifySize).observe(document.body);
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "X-Frame-Options": "ALLOWALL",
    },
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
