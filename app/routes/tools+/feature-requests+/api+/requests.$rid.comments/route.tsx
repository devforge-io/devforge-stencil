/**
 * POST /tools/feature-requests/api/requests/:rid/comments (CORS): add a
 * comment. Comments belong to a signed-in person: the bearer token from
 * /api/auth supplies the email and Anvil user id.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import type { AnvilError } from "~/lib/feature-requests/anvil.server";
import { embedUser } from "~/lib/feature-requests/embed-auth.server";
import { clientIp, corsHeaders, json, originBlocked, preflight, rateLimited, readBody } from "~/lib/feature-requests/http.server";
import { createComment, getProject, getRequest, publicComment } from "~/lib/feature-requests/store.server";

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return preflight(request);
  return json({ ok: false, error: "POST to this endpoint" }, { status: 405, headers: corsHeaders(request) });
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
    if (originBlocked(request, project.origins)) return json({ ok: false, error: "This site is not allowed to comment on this project" }, { status: 403, headers });
    if (rateLimited(`fr:comment:${clientIp(request)}`, 20, 10 * 60_000)) return json({ ok: false, error: "Too many comments, try again in a minute" }, { status: 429, headers });
    const user = embedUser(request);
    if (!user) return json({ ok: false, error: "Sign in to comment", signIn: true }, { status: 401, headers });
    const body = await readBody(request);
    if (body.website) return json({ ok: true, comment: null }, { headers });
    const comment = await createComment(req.id, { body: body.body ?? "", name: body.name, userId: user.id, ip: clientIp(request) });
    return json({ ok: true, comment: publicComment(comment) }, { headers });
  } catch (err) {
    const e = err as AnvilError;
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    return json({ ok: false, error: status >= 500 ? "Could not save the comment" : e.message }, { status, headers: corsHeaders(request) });
  }
}
