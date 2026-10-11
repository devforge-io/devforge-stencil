/**
 * Signed session cookie for the site-wide Devforge account.
 *
 * Anvil authenticates the person (login, register or emailed code) and issues
 * its JWT; once that succeeds this cookie becomes the app's own trust anchor
 * for later requests, so pages never need to re-verify Anvil tokens. The
 * refresh token is kept so account operations can be added later.
 *
 * One account, one cookie, for everything on devforge.io that needs a person:
 * /account/*, the feature-requests tool and /project. The cookie name
 * `_fr_session` predates the universal login and is kept so existing sessions
 * survive the change.
 */

import { createCookie, redirect } from "react-router";
import type { AnvilIdentity, AnvilTokens } from "../feature-requests/anvil.server";
import { SIGN_IN_PATH } from "./paths";

export type AccountUser = {
  id: string;
  email: string;
  username: string;
  /** Unix ms when the session was created. */
  iat: number;
};

type SessionPayload = AccountUser & { rt?: string };

const SESSION_MAX_AGE = 60 * 60 * 24 * 14; // 14 days

function secrets(): string[] {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is required for account sign-in");
  return [s];
}

function cookie() {
  return createCookie("_fr_session", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
    secrets: secrets(),
  });
}

/**
 * The cookie as it was scoped before the session went site-wide. Browsers only
 * delete a cookie when the clearing Set-Cookie matches its path, and an old
 * cookie at the narrower path also shadows the site-wide one under /tools, so
 * every sign-in and sign-out clears this scope as well.
 */
function legacyCookie() {
  return createCookie("_fr_session", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/tools/feature-requests",
    maxAge: SESSION_MAX_AGE,
    secrets: secrets(),
  });
}

export async function getAccountUser(request: Request): Promise<AccountUser | null> {
  let raw: unknown;
  try {
    raw = await cookie().parse(request.headers.get("Cookie") ?? "");
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<SessionPayload>;
  if (typeof p.id !== "string" || !p.id || typeof p.iat !== "number") return null;
  if (Date.now() - p.iat > SESSION_MAX_AGE * 1000) return null;
  return { id: p.id, email: typeof p.email === "string" ? p.email : "", username: typeof p.username === "string" ? p.username : "", iat: p.iat };
}

/** Loader/action guard: returns the user or redirects to the sign-in page with a return path. */
export async function requireAccountUser(request: Request, signInPath: string = SIGN_IN_PATH): Promise<AccountUser> {
  const user = await getAccountUser(request);
  if (user) return user;
  const url = new URL(request.url);
  const next = url.pathname + url.search;
  throw redirect(`${signInPath}?next=${encodeURIComponent(next)}`);
}

/** Headers that set the session for a freshly authenticated identity (and clear the legacy-path cookie). */
export async function accountSignInHeaders(identity: AnvilIdentity, tokens: AnvilTokens): Promise<Headers> {
  const payload: SessionPayload = {
    id: identity.sub,
    email: identity.email || identity.username,
    username: identity.username,
    iat: Date.now(),
    rt: tokens.refreshToken,
  };
  const headers = new Headers();
  headers.append("Set-Cookie", await cookie().serialize(payload));
  headers.append("Set-Cookie", await legacyCookie().serialize("", { maxAge: 0 }));
  return headers;
}

/** Headers that clear the session at both cookie scopes. */
export async function accountSignOutHeaders(): Promise<Headers> {
  const headers = new Headers();
  headers.append("Set-Cookie", await cookie().serialize("", { maxAge: 0 }));
  headers.append("Set-Cookie", await legacyCookie().serialize("", { maxAge: 0 }));
  return headers;
}
