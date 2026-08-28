/**
 * POST /tools/feature-requests/api/auth (CORS): sign in from the embed widget
 * with an emailed code. Sign-in and registration are the same flow: an
 * unknown address gets an Anvil account first (best-effort, like the suggest
 * form), then the code goes out. On success the response carries a signed
 * bearer token (`embed-auth.server.ts`) the widget sends on later writes.
 *
 * Body: { intent: "otp-request" | "otp-verify", email, code? }
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { AnvilError, anvilOtpRequest, anvilOtpVerify, identityFromToken, registerVisitor } from "~/lib/feature-requests/anvil.server";
import { signEmbedToken } from "~/lib/feature-requests/embed-auth.server";
import { clientIp, corsHeaders, json, preflight, rateLimited, readBody } from "~/lib/feature-requests/http.server";
import { isEmail } from "~/lib/feature-requests/store.server";

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return preflight(request);
  return json({ ok: false, error: "POST to this endpoint" }, { status: 405, headers: corsHeaders(request) });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return preflight(request);
  const headers = corsHeaders(request);
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, { status: 405, headers });
  const ip = clientIp(request);
  if (rateLimited(`fr:embed-auth:${ip}`, 15, 10 * 60_000)) {
    return json({ ok: false, error: "Too many attempts. Try again in a few minutes." }, { status: 429, headers });
  }
  const body = await readBody(request);
  const intent = body.intent ?? "otp-request";
  const email = (body.email ?? "").trim().toLowerCase();
  if (!isEmail(email)) return json({ ok: false, error: "Enter a valid email address." }, { status: 400, headers });

  try {
    if (intent === "otp-verify") {
      const code = (body.code ?? "").trim();
      if (!code) return json({ ok: false, error: "Enter the code from the email." }, { status: 400, headers });
      const tokens = await anvilOtpVerify(email, code);
      const identity = identityFromToken(tokens.accessToken);
      if (!identity) throw new AnvilError("Anvil returned an unreadable token", 502);
      const userEmail = identity.email || identity.username;
      const token = signEmbedToken({ id: identity.sub, email: userEmail, username: identity.username });
      return json({ ok: true, token, user: { email: userEmail, username: identity.username } }, { headers });
    }
    if (intent !== "otp-request") return json({ ok: false, error: "Unknown intent" }, { status: 400, headers });
    // Registration and sign-in are one step: make sure the account exists
    // (409 = already there), then send the code.
    await registerVisitor(email);
    await anvilOtpRequest(email);
    return json({ ok: true, stage: "code", notice: "We emailed " + email + " a sign-in code. Enter it below." }, { headers });
  } catch (err) {
    const e = err as AnvilError;
    const status = typeof e.status === "number" ? e.status : 500;
    let message = "Sign-in failed. Please try again.";
    if (status === 401 || status === 403) message = intent === "otp-verify" ? "That code is not valid or has expired." : "Could not send a code to that address.";
    else if (status === 503) message = "Email sending is not configured, so codes cannot go out right now.";
    else if (status === 429) message = "Too many attempts. Try again in a few minutes.";
    return json({ ok: false, error: message }, { status: status >= 400 && status < 600 ? status : 500, headers });
  }
}
