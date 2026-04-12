import { getAssetContent } from "~/lib/github.server";
import type { Route } from "./+types/route";

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

export async function loader({ params, request }: Route.LoaderArgs) {
  const { filename } = params;

  const url = new URL(request.url);
  const ref = url.searchParams.get("ref") ?? url.searchParams.get("branch") ?? undefined;

  const asset = await getAssetContent(filename, ref);
  if (!asset) {
    return new Response("Not found", { status: 404 });
  }

  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

  return new Response(asset.content, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
