/** POST /tools/feature-requests/api/projects/:id/requests (CORS): submit a feature request. */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import type { AnvilError } from "~/lib/feature-requests/anvil.server";
import { clientIp, corsHeaders, json, originBlocked, preflight, rateLimited, readBody } from "~/lib/feature-requests/http.server";
import { createRequest, getProject, isVoterKey, publicRequest, toggleVote } from "~/lib/feature-requests/store.server";

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return preflight(request);
  return json({ ok: false, error: "POST a request to this endpoint" }, { status: 405, headers: corsHeaders(request) });
}

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return preflight(request);
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, { status: 405, headers: corsHeaders(request) });
  try {
    const project = await getProject(params.id ?? "");
    if (!project) return json({ ok: false, error: "Unknown project" }, { status: 404, headers: corsHeaders(request) });
    const headers = corsHeaders(request, project.origins);
    if (originBlocked(request, project.origins)) return json({ ok: false, error: "This site is not allowed to submit to this project" }, { status: 403, headers });
    const ip = clientIp(request);
    const body = await readBody(request);
    // Honeypot: bots fill every field. Pretend it worked and store nothing.
    if (body.website) return json({ ok: true, request: null }, { headers });
    if (rateLimited(`fr:submit:${ip}`, 10, 10 * 60_000) || rateLimited(`fr:submit:project:${project.id}`, 120, 60 * 60_000)) {
      return json({ ok: false, error: "Too many requests, try again in a minute" }, { status: 429, headers });
    }
    const origin = request.headers.get("origin") ?? (request.headers.get("referer") ? new URL(request.headers.get("referer")!).origin : "");
    const created = await createRequest(project.id, { title: body.title ?? "", details: body.details ?? "", email: body.email ?? "", origin, ip });
    let voted = false;
    let votes = 0;
    if (project.boardEnabled && isVoterKey(body.voter)) {
      const v = await toggleVote(created.id, body.voter).catch(() => null);
      if (v) {
        voted = v.voted;
        votes = v.votes;
      }
    }
    return json({ ok: true, request: { ...publicRequest(created, voted), votes } }, { status: 201, headers });
  } catch (err) {
    const e = err as AnvilError;
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    return json({ ok: false, error: status >= 500 ? "Could not save the request" : e.message }, { status, headers: corsHeaders(request) });
  }
}
