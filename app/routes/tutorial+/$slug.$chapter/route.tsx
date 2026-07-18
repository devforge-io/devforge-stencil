import { getPublishedContent } from "~/lib/content.server";
import { renderTutorialChapterResponse } from "~/lib/public-page.server";
import type { Route } from "./+types/route";

/** GET /tutorial/<slug>/<chapter> — a chapter with left menu + breadcrumbs. */
export async function loader({ params, request }: Route.LoaderArgs) {
  const content = await getPublishedContent(params.slug);
  if (!content || content.contentType !== "tutorial") {
    throw new Response("Not Found", { status: 404 });
  }
  return renderTutorialChapterResponse(content, params.chapter, request);
}
