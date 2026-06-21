import { redirect } from "react-router";
import { getContent, removeContent } from "~/lib/content.server";
import { removePageFromAllComponentIndices } from "~/lib/component.server";
import type { Route } from "./+types/route";

export async function action({ params }: Route.ActionArgs) {
  const content = await getContent(params.slug);
  if (!content) {
    throw new Response("Not Found", { status: 404 });
  }

  await removeContent(params.slug, content.sha, content.contentType);
  if (content.contentType === "page") {
    await removePageFromAllComponentIndices(params.slug);
  }

  return redirect("/content");
}
