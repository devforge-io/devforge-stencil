import { renderBody } from "~/lib/markdown.server";
import type { Route } from "./+types/route";

export async function action({ request }: Route.ActionArgs) {
  const raw = await request.text();
  if (!raw) {
    return new Response("", { headers: { "Content-Type": "text/html" } });
  }

  const html = await renderBody(raw);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
