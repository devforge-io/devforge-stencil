import { getPublishedContentByPath } from "~/lib/content.server";
import { renderPublicPageResponse } from "~/lib/public-page.server";
import type { Route } from "./+types/route";

// Paths owned by the app's own routes — never resolve a page for these.
const RESERVED_PREFIXES = [
  "/content",
  "/api",
  "/embed",
  "/guide",
  "/login",
  "/logout",
  "/components",
  "/settings",
  "/articles",
  "/.well-known",
];

/**
 * Public catch-all: serve a published page at its assigned `path` frontmatter.
 * This is a resource route (no component) — the loader returns the full HTML
 * document directly, so the page renders standalone at its custom URL.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const path = "/" + (params["*"] ?? "").replace(/^\/+/, "");

  if (RESERVED_PREFIXES.some((p) => path === p || path.startsWith(p + "/"))) {
    throw new Response("Not Found", { status: 404 });
  }

  const content = await getPublishedContentByPath(path);
  if (!content) {
    throw new Response("Not Found", { status: 404 });
  }

  return renderPublicPageResponse(content, request);
}
