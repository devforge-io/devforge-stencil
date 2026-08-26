/** POST /tools/feature-requests/api/requests/:rid/vote (CORS): toggle this voter's upvote. */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import type { AnvilError } from "~/lib/feature-requests/anvil.server";
import { registerVisitor } from "~/lib/feature-requests/anvil.server";
import { clientIp, corsHeaders, json, originBlocked, preflight, rateLimited, readBody } from "~/lib/feature-requests/http.server";
import { getProject, getRequest, isEmail, toggleVote } from "~/lib/feature-requests/store.server";

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return preflight(request);
  return json({ ok: false, error: "POST to this endpoint" }, { status: 405, headers: corsHeaders(request) });
}

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return preflight(request);
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, { status: 405, headers: corsHeaders(request) });
  try {
    const req = await getRequest(params.rid ?? "");
    if (!req) return json({ ok: false, error: "Unknown request" }, { status: 404, headers: corsHeaders(request) });
    const project = await getProject(req.projectId);
    if (!project) return json({ ok: false, error: "Unknown project" }, { status: 404, headers: corsHeaders(request) });
    const headers = corsHeaders(request, project.origins);
    if (!project.boardEnabled) return json({ ok: false, error: "Voting is off for this project" }, { status: 403, headers });
    if (originBlocked(request, project.origins)) return json({ ok: false, error: "This site is not allowed to vote on this project" }, { status: 403, headers });
    if (rateLimited(`fr:vote:${clientIp(request)}`, 60, 10 * 60_000)) return json({ ok: false, error: "Too many votes, try again in a minute" }, { status: 429, headers });
    const body = await readBody(request);
    const email = (body.email ?? "").trim();
    if (!isEmail(email)) return json({ ok: false, error: "Enter your email address to vote" }, { status: 400, headers });
    // Votes belong to people: register the address (best-effort, sends the
    // verification email on a first appearance) and key the vote on it.
    const visitor = await registerVisitor(email);
    const result = await toggleVote(req.id, { email, userId: visitor.userId, voter: body.voter });
    if (!result) return json({ ok: false, error: "This request cannot be voted on" }, { status: 404, headers });
    return json({ ok: true, votes: result.votes, voted: result.voted, account: visitor.account, verificationSent: visitor.verificationSent }, { headers });
  } catch (err) {
    const e = err as AnvilError;
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    return json({ ok: false, error: status >= 500 ? "Could not record the vote" : e.message }, { status, headers: corsHeaders(request) });
  }
}
