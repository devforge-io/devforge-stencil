import { listPublishedContent } from "~/lib/content.server";
import { requireApiToken } from "~/lib/auth.server";
import type { Route } from "./+types/route";

export async function loader({ request }: Route.LoaderArgs) {
  const denied = requireApiToken(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const tag = url.searchParams.get("tag");

  let items: Awaited<ReturnType<typeof listPublishedContent>>;
  try {
    items = await listPublishedContent();
  } catch {
    return Response.json(
      { error: "GitHub not configured or unreachable", items: [], total: 0 },
      { status: 503, headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }

  if (tag) {
    items = items.filter((item) => item.meta.tags?.includes(tag));
  }

  return Response.json(
    {
      items: items.map((item) => ({
        slug: item.slug,
        contentType: item.contentType,
        title: item.meta.title,
        description: item.meta.description,
        tags: item.meta.tags,
        publishedAt: item.meta.publishedAt,
      })),
      total: items.length,
    },
    {
      headers: {
        "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}
