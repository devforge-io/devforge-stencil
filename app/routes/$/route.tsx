import { getPublishedContentByPath } from "~/lib/content.server";
import { renderPublicPageResponse, renderNotFoundResponse } from "~/lib/public-page.server";
import { resolveFileUpload, isReservedPath } from "~/lib/file-uploads.server";
import type { Route } from "./+types/route";

/**
 * Public catch-all. In order: reserved app paths 404; an uploaded file assigned
 * to this URL is streamed with its content type; otherwise a published page at
 * its assigned `path` frontmatter is rendered as a standalone HTML document.
 *
 * This is a resource route (no component) — the loader returns the response
 * directly, so files/pages serve at their custom URL.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const path = "/" + (params["*"] ?? "").replace(/^\/+/, "");

  if (isReservedPath(path)) {
    throw new Response("Not Found", { status: 404 });
  }

  // Uploaded files take precedence (exact URL match).
  const file = await resolveFileUpload(path);
  if (file) {
    const body = new Uint8Array(file.content);
    return new Response(body, {
      headers: {
        "Content-Type": file.contentType,
        "Content-Length": String(body.length),
        "Cache-Control": "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  const content = await getPublishedContentByPath(path);
  if (!content) {
    return renderNotFoundResponse(request);
  }

  return renderPublicPageResponse(content, request);
}
