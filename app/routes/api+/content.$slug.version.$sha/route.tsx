import { getContent, getContentAtVersion } from "~/lib/content.server";
import { getFileAtCommit } from "~/lib/github.server";
import * as Diff from "diff";
import type { Route } from "./+types/route";

export async function loader({ params, request }: Route.LoaderArgs) {
  const { slug, sha } = params;
  const url = new URL(request.url);
  const compareTo = url.searchParams.get("compare");

  // Detect content type from the current version
  const current = await getContent(slug);
  const type = current?.contentType ?? "markdown";

  const raw = await getFileAtCommit(slug, sha, type);
  if (!raw) {
    return Response.json({ error: "Version not found" }, { status: 404 });
  }

  const parsed = await getContentAtVersion(slug, sha, type);

  const result: {
    raw: string;
    html: string;
    diff?: Array<{ value: string; added?: boolean; removed?: boolean }>;
  } = {
    raw,
    html: parsed?.html ?? "",
  };

  if (compareTo) {
    const compareRaw = await getFileAtCommit(slug, compareTo, type);
    if (compareRaw) {
      const changes = Diff.diffLines(compareRaw, raw);
      result.diff = changes.map((c) => ({
        value: c.value,
        added: c.added || undefined,
        removed: c.removed || undefined,
      }));
    }
  }

  return Response.json(result);
}
