import { getSettings, saveSettings } from "~/lib/settings.server";
import { requireAuth, can } from "~/lib/auth.server";
import type { Route } from "./+types/route";

// Settings an editor may change (lightweight editor prefs); anything else is admin.
const EDITOR_SAFE_KEYS = new Set(["editorDarkMode"]);

export async function loader({ request }: Route.LoaderArgs) {
  await requireAuth(request);
  const { settings, sha } = await getSettings();
  return Response.json({ settings, sha });
}

export async function action({ request }: Route.ActionArgs) {
  const { role } = await requireAuth(request);
  const body = await request.json();

  // Patch mode: merge `patch` into current settings.
  if (body && typeof body === "object" && "patch" in body) {
    const patch = (body.patch ?? {}) as Record<string, unknown>;
    const onlySafeKeys = Object.keys(patch).every((k) => EDITOR_SAFE_KEYS.has(k));
    if (!onlySafeKeys && !can.manageSettings(role)) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    const { settings: current, sha: currentSha } = await getSettings();
    const merged = { ...current, ...patch };
    const result = await saveSettings(merged, currentSha || undefined);
    return Response.json({ ok: true, sha: result.sha, settings: merged });
  }

  if (!can.manageSettings(role)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  const { settings, sha } = body;
  const result = await saveSettings(settings, sha);
  return Response.json({ ok: true, sha: result.sha });
}
