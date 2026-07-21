import { getPublishedContent } from "~/lib/content.server";
import { renderTutorialChapterResponse, renderNotFoundResponse } from "~/lib/public-page.server";
import type { Route } from "./+types/route";

/** GET /tutorial/<slug>/<chapter> — a chapter with left menu + breadcrumbs. */
export async function loader({ params, request }: Route.LoaderArgs) {
  const content = await getPublishedContent(params.slug);
  if (!content || content.contentType !== "tutorial") {
    return renderNotFoundResponse(request);
  }
  return renderTutorialChapterResponse(content, params.chapter, request);
}
