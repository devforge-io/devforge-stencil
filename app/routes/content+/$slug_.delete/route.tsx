import { redirect } from "react-router";
import { getContent, removeContent } from "~/lib/content.server";
import type { Route } from "./+types/route";

export async function action({ params }: Route.ActionArgs) {
  const content = await getContent(params.slug);
  if (!content) {
    throw new Response("Not Found", { status: 404 });
  }

  await removeContent(params.slug, content.sha);

  return redirect("/content");
}
