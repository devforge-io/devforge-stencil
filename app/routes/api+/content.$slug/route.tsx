import { getPublishedContent } from "~/lib/content.server";
import type { Route } from "./+types/route";

export async function loader({ params, request }: Route.LoaderArgs) {
  let content: Awaited<ReturnType<typeof getPublishedContent>>;
  try {
    content = await getPublishedContent(params.slug);
  } catch {
    return Response.json(
      { error: "GitHub not configured or unreachable" },
      { status: 503, headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }
  if (!content) {
    return Response.json(
      { error: "Not found" },
      { status: 404, headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }

  const url = new URL(request.url);
  const format = url.searchParams.get("format");

  if (format === "html") {
    return new Response(content.html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  return Response.json(
    {
      meta: {
        slug: content.slug,
        title: content.frontmatter.title,
        description: content.frontmatter.description,
        tags: content.frontmatter.tags,
        publishedAt: content.frontmatter.publishedAt,
        updatedAt: content.frontmatter.updatedAt,
      },
      html: content.html,
      raw: content.raw,
      sha: content.sha,
    },
    {
      headers: {
        "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}
