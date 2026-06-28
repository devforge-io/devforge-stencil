import { listComponents, saveComponent } from "~/lib/component.server";
import { requireAuth } from "~/lib/auth.server";
import type { Route } from "./+types/route";

// GET /api/components — list all components
export async function loader({ request }: Route.LoaderArgs) {
  await requireAuth(request);
  const components = await listComponents();
  return Response.json({ components });
}

// POST /api/components — create a new component
export async function action({ request }: Route.ActionArgs) {
  await requireAuth(request);
  const data = await request.json();

  const { slug, name, category, icon, description, html, css, projectData, type, spec } = data;

  if (!slug || !name) {
    return Response.json({ error: "slug and name are required" }, { status: 400 });
  }

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return Response.json({ error: "Invalid slug format" }, { status: 400 });
  }

  const result = await saveComponent(slug, {
    name,
    category: category || "Custom",
    icon,
    description,
    html: html || "",
    css: css || "",
    projectData,
    type: type === "conditional" ? "conditional" : undefined,
    spec,
  });

  return Response.json({ ok: true, sha: result.sha });
}
