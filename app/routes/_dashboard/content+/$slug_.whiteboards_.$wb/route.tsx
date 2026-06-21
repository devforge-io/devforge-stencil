import { Link, useFetcher } from "react-router";
import { useCallback } from "react";
import {
  getWhiteboard,
  saveWhiteboard,
  removeWhiteboard,
} from "~/lib/whiteboard.server";
import { getContent } from "~/lib/content.server";
import { WhiteboardEditor } from "~/components/whiteboard-editor";
import type { Route } from "./+types/route";

export async function loader({ params }: Route.LoaderArgs) {
  const content = await getContent(params.slug);
  if (!content) {
    throw new Response("Content not found", { status: 404 });
  }
  const whiteboard = await getWhiteboard(params.slug, params.wb);
  return {
    pageSlug: params.slug,
    pageTitle: content.frontmatter.title,
    wbSlug: params.wb,
    scene: whiteboard?.scene ?? null,
    sha: whiteboard?.sha ?? null,
    imageUrl: whiteboard?.imageUrl ?? `/api/assets/whiteboard-${params.slug}-${params.wb}.png`,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "delete") {
    const sha = formData.get("sha") as string;
    if (sha) {
      await removeWhiteboard(params.slug, params.wb, sha);
    }
    return { ok: true, deleted: true };
  }

  const sceneJson = formData.get("scene") as string;
  const imageDataUrl = formData.get("image") as string | null;
  const sha = (formData.get("sha") as string) || undefined;

  if (!sceneJson) {
    return { error: "No scene data" };
  }

  const scene = JSON.parse(sceneJson);
  const result = await saveWhiteboard(
    params.slug,
    params.wb,
    scene,
    imageDataUrl || null,
    sha
  );

  return { ok: true, sha: result.sha, imageUrl: result.imageUrl };
}

export default function WhiteboardEdit({ loaderData }: Route.ComponentProps) {
  const { pageSlug, pageTitle, wbSlug, scene, sha, imageUrl } = loaderData;
  const fetcher = useFetcher<typeof action>();
  const saving = fetcher.state !== "idle";

  const currentSha =
    fetcher.data && "sha" in fetcher.data ? fetcher.data.sha : sha;

  const handleSave = useCallback(
    async (newScene: unknown, imageDataUrl: string | null) => {
      const formData = new FormData();
      formData.set("scene", JSON.stringify(newScene));
      if (imageDataUrl) formData.set("image", imageDataUrl);
      if (currentSha) formData.set("sha", currentSha);
      fetcher.submit(formData, { method: "post" });
    },
    [fetcher, currentSha]
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">{wbSlug}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Whiteboard for{" "}
            <Link
              to={`/content/${pageSlug}`}
              className="text-brand-600 dark:text-brand-200 hover:underline"
            >
              {pageTitle}
            </Link>{" "}
            &middot; Embed:{" "}
            <code className="bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded text-xs">
              {imageUrl}
            </code>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {fetcher.data && "ok" in fetcher.data && fetcher.data.ok && (
            <span className="text-sm text-green-600 dark:text-green-400">
              Saved
            </span>
          )}
          <Link
            to={`/content/${pageSlug}/whiteboards`}
            className="px-3 py-1.5 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-sm"
          >
            Back to list
          </Link>
          <Link
            to={`/content/${pageSlug}/edit`}
            className="px-3 py-1.5 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-sm"
          >
            Back to page
          </Link>
        </div>
      </div>

      <WhiteboardEditor
        initialScene={scene}
        onSave={handleSave}
        saving={saving}
      />
    </div>
  );
}
