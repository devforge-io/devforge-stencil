import { getContentAtVersion } from "~/lib/content.server";
import { getFileAtCommit } from "~/lib/github.server";
import * as Diff from "diff";
import type { Route } from "./+types/route";

export async function loader({ params, request }: Route.LoaderArgs) {
  const { slug, sha } = params;
  const url = new URL(request.url);
  const compareTo = url.searchParams.get("compare");

  const raw = await getFileAtCommit(slug, sha);
  if (!raw) {
    return Response.json({ error: "Version not found" }, { status: 404 });
  }

  const parsed = await getContentAtVersion(slug, sha);

  const result: {
    raw: string;
    html: string;
    diff?: Array<{ value: string; added?: boolean; removed?: boolean }>;
  } = {
    raw,
    html: parsed?.html ?? "",
  };

  // If comparing to another version, compute a word-level diff
  if (compareTo) {
    const compareRaw = await getFileAtCommit(slug, compareTo);
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
