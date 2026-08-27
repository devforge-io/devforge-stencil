/**
 * /tools/feature-requests/api/requests/:rid (CORS)
 *
 * GET: one request in full, plus whether the caller voted for it and whether
 * they may edit it (their remembered email matches the submitter's).
 * POST: creator edit. The person who submitted the request (same email) can
 * rewrite the details to build the idea out; enforced server-side.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import type { AnvilError } from "~/lib/feature-requests/anvil.server";
import { clientIp, corsHeaders, json, originBlocked, preflight, rateLimited, readBody } from "~/lib/feature-requests/http.server";
import { getProject, getRequest, isEmail, publicProject, publicRequest, updateRequestDetails, votedRequestIds } from "~/lib/feature-requests/store.server";

function canEdit(requestEmail: string, email: string): boolean {
  return Boolean(requestEmail) && isEmail(email) && requestEmail.trim().toLowerCase() === email.trim().toLowerCase();
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return preflight(request);
  try {
    const req = await getRequest(params.rid ?? "");
    if (!req || req.status === "declined") return json({ ok: false, error: "Unknown request" }, { status: 404, headers: corsHeaders(request) });
    const project = await getProject(req.projectId);
    if (!project) return json({ ok: false, error: "Unknown project" }, { status: 404, headers: corsHeaders(request) });
    // Reads are public, like the board; the allow-list only gates writes.
    const headers = corsHeaders(request);
    const search = new URL(request.url).searchParams;
    const email = search.get("email") ?? "";
    const identity = { email: email || undefined, voter: search.get("voter") ?? undefined };
    const voted = (await votedRequestIds(project.id, identity)).has(req.id);
    return json({ ok: true, project: publicProject(project), request: publicRequest(req, voted), canEdit: canEdit(req.email, email) }, { headers });
  } catch (err) {
    const e = err as AnvilError;
    return json({ ok: false, error: e.status === 400 ? e.message : "Could not load the request" }, { status: e.status && e.status >= 400 ? e.status : 500, headers: corsHeaders(request) });
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return preflight(request);
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, { status: 405, headers: corsHeaders(request) });
  try {
    const req = await getRequest(params.rid ?? "");
    if (!req || req.status === "declined") return json({ ok: false, error: "Unknown request" }, { status: 404, headers: corsHeaders(request) });
    const project = await getProject(req.projectId);
    if (!project) return json({ ok: false, error: "Unknown project" }, { status: 404, headers: corsHeaders(request) });
    const headers = corsHeaders(request, project.origins);
    if (originBlocked(request, project.origins)) return json({ ok: false, error: "This site is not allowed to edit requests on this project" }, { status: 403, headers });
    if (rateLimited(`fr:edit:${clientIp(request)}`, 20, 10 * 60_000)) return json({ ok: false, error: "Too many edits, try again in a minute" }, { status: 429, headers });
    const body = await readBody(request);
    const updated = await updateRequestDetails(req.id, (body.email ?? "").trim(), body.details ?? "");
    if (!updated) return json({ ok: false, error: "Unknown request" }, { status: 404, headers });
    const identity = { email: (body.email ?? "").trim() || undefined, voter: body.voter };
    const voted = (await votedRequestIds(project.id, identity)).has(updated.id);
    return json({ ok: true, request: publicRequest(updated, voted), canEdit: true }, { headers });
  } catch (err) {
    const e = err as AnvilError;
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    return json({ ok: false, error: status >= 500 ? "Could not save the edit" : e.message }, { status, headers: corsHeaders(request) });
  }
}
