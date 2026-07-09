import { getPublishedContent } from "~/lib/content.server";
import { renderArticleEmbedResponse } from "~/lib/public-page.server";
import type { Route } from "./+types/route";

/**
 * GET /embed/articles/<slug> — the article body + styling only (no template),
 * for iframe-embedding on third-party sites. Published articles only.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const content = await getPublishedContent(params.slug);
  if (!content || content.contentType !== "article") {
    throw new Response("Not Found", { status: 404 });
  }
  return renderArticleEmbedResponse(content, request);
}
