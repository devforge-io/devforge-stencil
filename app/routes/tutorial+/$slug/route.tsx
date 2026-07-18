import { getPublishedContent } from "~/lib/content.server";
import { renderTutorialRootResponse } from "~/lib/public-page.server";
import type { Route } from "./+types/route";

/** GET /tutorial/<slug> — the tutorial overview (root template or built-in). */
export async function loader({ params, request }: Route.LoaderArgs) {
  const content = await getPublishedContent(params.slug);
  if (!content || content.contentType !== "tutorial") {
    throw new Response("Not Found", { status: 404 });
  }
  return renderTutorialRootResponse(content, request);
}
