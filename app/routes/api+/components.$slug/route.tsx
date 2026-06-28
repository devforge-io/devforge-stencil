import { getComponent, saveComponent, deleteComponent } from "~/lib/component.server";
import { requireAuth } from "~/lib/auth.server";
import type { Route } from "./+types/route";

// GET /api/components/:slug — get a single component
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireAuth(request);
  const component = await getComponent(params.slug);
  if (!component) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return Response.json({ component });
}

// PUT /api/components/:slug — update a component
// DELETE /api/components/:slug — delete a component
export async function action({ request, params }: Route.ActionArgs) {
  await requireAuth(request);

  if (request.method === "DELETE") {
    const { sha } = await request.json();
    if (!sha) {
      return Response.json({ error: "sha is required" }, { status: 400 });
    }
    await deleteComponent(params.slug, sha);
    return Response.json({ ok: true });
  }

  // PUT — update
  const data = await request.json();
  const { name, category, icon, description, html, css, projectData, sha, type, spec } = data;

  if (!name) {
    return Response.json({ error: "name is required" }, { status: 400 });
  }

  const result = await saveComponent(params.slug, {
    name,
    category: category || "Custom",
    icon,
    description,
    html: html || "",
    css: css || "",
    projectData,
    type: type === "conditional" ? "conditional" : undefined,
    spec,
  }, sha);

  return Response.json({ ok: true, sha: result.sha });
}
