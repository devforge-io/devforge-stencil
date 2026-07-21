import { getPublishedContent } from "~/lib/content.server";
import { renderPublicPageResponse, renderNotFoundResponse } from "~/lib/public-page.server";
import type { Route } from "./+types/route";

/**
 * Public canonical article URL: `/articles/<slug>`. Article cards (rendered by
 * the article page-builder blocks) link here. Resource route — the loader
 * returns the full HTML document directly.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const content = await getPublishedContent(params.slug);
  if (!content || content.contentType !== "article") {
    return renderNotFoundResponse(request);
  }
  return renderPublicPageResponse(content, request);
}
