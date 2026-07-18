import { requireAuth } from "~/lib/auth.server";
import { getContent } from "~/lib/content.server";
import { renderTutorialChapterResponse } from "~/lib/public-page.server";
import type { Route } from "./+types/route";

/**
 * GET /api/tutorial-preview/<slug>/<chapter> — an authenticated, draft-aware
 * render of a tutorial chapter (uses the assigned template from the draft
 * branch), for the admin content-view preview iframe. Never cached.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireAuth(request);
  const content = await getContent(params.slug);
  if (!content || content.contentType !== "tutorial") {
    throw new Response("Not Found", { status: 404 });
  }
  return renderTutorialChapterResponse(content, params.chapter, request, { draft: true });
}
