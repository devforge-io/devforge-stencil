import { getPublishedContent } from "~/lib/content.server";
import { renderTutorialRootResponse, renderNotFoundResponse } from "~/lib/public-page.server";
import type { Route } from "./+types/route";

/** GET /tutorial/<slug> — the tutorial overview (root template or built-in). */
export async function loader({ params, request }: Route.LoaderArgs) {
  const content = await getPublishedContent(params.slug);
  if (!content || content.contentType !== "tutorial") {
    return renderNotFoundResponse(request);
  }
  return renderTutorialRootResponse(content, request);
}
