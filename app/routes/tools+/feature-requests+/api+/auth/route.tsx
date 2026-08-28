/**
 * POST /tools/feature-requests/api/auth (CORS): sign in or register from the
 * embed widget. Backed by the same Anvil auth endpoints as the sign-in and
 * sign-up pages; on success the response carries a signed bearer token
 * (`embed-auth.server.ts`) the widget sends on later writes.
 *
 * Body: { intent: "login" | "register" | "otp-request" | "otp-verify",
 *         email, password?, code? }
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { AnvilError, anvilLogin, anvilOtpRequest, anvilOtpVerify, anvilRegister, identityFromToken } from "~/lib/feature-requests/anvil.server";
import { signEmbedToken } from "~/lib/feature-requests/embed-auth.server";
import { clientIp, corsHeaders, json, preflight, rateLimited, readBody } from "~/lib/feature-requests/http.server";
import { isEmail } from "~/lib/feature-requests/store.server";

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return preflight(request);
  return json({ ok: false, error: "POST to this endpoint" }, { status: 405, headers: corsHeaders(request) });
}

function signedIn(accessToken: string, headers: Headers): Response {
  const identity = identityFromToken(accessToken);
  if (!identity) throw new AnvilError("Anvil returned an unreadable token", 502);
  const email = identity.email || identity.username;
  const token = signEmbedToken({ id: identity.sub, email, username: identity.username });
  return json({ ok: true, token, user: { email, username: identity.username } }, { headers });
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
  const intent = body.intent ?? "login";
  const email = (body.email ?? "").trim().toLowerCase();
  if (!isEmail(email)) return json({ ok: false, error: "Enter a valid email address." }, { status: 400, headers });

  try {
    if (intent === "otp-request") {
      await anvilOtpRequest(email);
      return json({ ok: true, stage: "code", notice: "If that address has an account, a sign-in code is on its way." }, { headers });
    }
    if (intent === "otp-verify") {
      const code = (body.code ?? "").trim();
      if (!code) return json({ ok: false, error: "Enter the code from the email." }, { status: 400, headers });
      return signedIn((await anvilOtpVerify(email, code)).accessToken, headers);
    }
    const password = body.password ?? "";
    if (intent === "register") {
      if (password.length < 10) return json({ ok: false, error: "Use a password of at least 10 characters." }, { status: 400, headers });
      if (password.length > 200) return json({ ok: false, error: "That password is too long." }, { status: 400, headers });
      try {
        await anvilRegister(email, password);
      } catch (err) {
        const e = err as AnvilError;
        if (e.status === 409) return json({ ok: false, error: "There is already an account for that email. Sign in instead." }, { status: 409, headers });
        if (e.status === 401 || e.status === 403) {
          return json({ ok: false, error: "Password sign-up is not available right now. Use the emailed code instead.", otpOnly: true }, { status: 403, headers });
        }
        throw err;
      }
      return signedIn((await anvilLogin(email, password)).accessToken, headers);
    }
    if (!password) return json({ ok: false, error: "Enter your password." }, { status: 400, headers });
    return signedIn((await anvilLogin(email, password)).accessToken, headers);
  } catch (err) {
    const e = err as AnvilError;
    const status = typeof e.status === "number" ? e.status : 500;
    let message = intent === "register" ? "Could not create the account. Please try again." : "Sign-in failed. Please try again.";
    if (status === 401 || status === 403) message = intent === "otp-verify" ? "That code is not valid or has expired." : "Email or password is wrong.";
    else if (status === 503) message = intent.startsWith("otp") ? "Email sending is not configured, so codes cannot go out. Use a password instead." : "The database is not reachable right now. Please try again shortly.";
    else if (status === 429) message = "Too many attempts. Try again in a few minutes.";
    return json({ ok: false, error: message }, { status: status >= 400 && status < 600 ? status : 500, headers });
  }
}
