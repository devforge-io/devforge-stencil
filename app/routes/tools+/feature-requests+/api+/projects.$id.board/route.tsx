/** GET /tools/feature-requests/api/projects/:id/board (CORS): project info + visible requests. */

import type { LoaderFunctionArgs } from "react-router";
import type { AnvilError } from "~/lib/feature-requests/anvil.server";
import { embedUser } from "~/lib/feature-requests/embed-auth.server";
import { corsHeaders, json, preflight } from "~/lib/feature-requests/http.server";
import { getProject, listRequests, publicProject, publicRequest, votedRequestIds } from "~/lib/feature-requests/store.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return preflight(request);
  try {
    const project = await getProject(params.id ?? "");
    if (!project) return json({ ok: false, error: "Unknown project" }, { status: 404, headers: corsHeaders(request) });
    // Reads are public (the board is public); the origin allow-list only
    // gates writes (submissions and votes).
    const headers = corsHeaders(request);
    const search = new URL(request.url).searchParams;
    const user = embedUser(request);
    const identity = { email: user ? user.email : (search.get("email") ?? undefined), voter: search.get("voter") ?? undefined };
    const [requests, voted] = project.boardEnabled ? await Promise.all([listRequests(project.id), votedRequestIds(project.id, identity)]) : [[], new Set<string>()];
    return json({ ok: true, project: publicProject(project), requests: requests.map((r) => publicRequest(r, voted.has(r.id))) }, { headers });
  } catch (err) {
    const e = err as AnvilError;
    return json({ ok: false, error: e.status === 400 ? e.message : "Could not load the board" }, { status: e.status && e.status >= 400 ? e.status : 500, headers: corsHeaders(request) });
  }
}
