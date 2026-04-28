import { renderWikitextBody } from "~/lib/wikipedia.server";
import type { Route } from "./+types/route";

export async function action({ request }: Route.ActionArgs) {
  const raw = await request.text();
  if (!raw) {
    return new Response("", { headers: { "Content-Type": "text/html" } });
  }

  const html = renderWikitextBody(raw);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
