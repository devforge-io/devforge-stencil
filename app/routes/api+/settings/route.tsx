import { getSettings, saveSettings } from "~/lib/settings.server";
import { requireAuth } from "~/lib/auth.server";
import type { Route } from "./+types/route";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAuth(request);
  const { settings, sha } = await getSettings();
  return Response.json({ settings, sha });
}

export async function action({ request }: Route.ActionArgs) {
  await requireAuth(request);
  const body = await request.json();

  // Patch mode: merge `patch` into current settings
  if (body && typeof body === "object" && "patch" in body) {
    const { settings: current, sha: currentSha } = await getSettings();
    const merged = { ...current, ...body.patch };
    const result = await saveSettings(merged, currentSha || undefined);
    return Response.json({ ok: true, sha: result.sha, settings: merged });
  }

  const { settings, sha } = body;
  const result = await saveSettings(settings, sha);
  return Response.json({ ok: true, sha: result.sha });
}
