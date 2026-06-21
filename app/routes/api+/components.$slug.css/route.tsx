import { getComponentCss } from "~/lib/component.server";
import type { Route } from "./+types/route";

// GET /api/components/:slug.css — serve compiled CSS for a component
export async function loader({ params }: Route.LoaderArgs) {
  const css = await getComponentCss(params.slug);
  if (!css) {
    return new Response("/* not found */", {
      status: 404,
      headers: { "Content-Type": "text/css" },
    });
  }
  return new Response(css, {
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
