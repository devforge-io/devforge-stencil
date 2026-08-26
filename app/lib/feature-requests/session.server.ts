/**
 * Signed session cookie for the feature-requests tool.
 *
 * Anvil authenticates the person (login, register or email code) and issues
 * its JWT; once that succeeds this cookie becomes the app's own trust anchor
 * for later requests, so pages never need to re-verify Anvil tokens. The
 * refresh token is kept so account operations can be added later.
 */

import { createCookie, redirect } from "react-router";
import type { AnvilIdentity, AnvilTokens } from "./anvil.server";

export type FrUser = {
  id: string;
  email: string;
  username: string;
  /** Unix ms when the session was created. */
  iat: number;
};

type SessionPayload = FrUser & { rt?: string };

const SESSION_MAX_AGE = 60 * 60 * 24 * 14; // 14 days

function secrets(): string[] {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is required for the feature-requests tool");
  return [s];
}

function cookie() {
  return createCookie("_fr_session", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    // Site-wide: the same session serves /tools/feature-requests and /project.
    path: "/",
    maxAge: SESSION_MAX_AGE,
    secrets: secrets(),
  });
}

/**
 * The cookie as it was scoped before /project existed. Browsers only delete a
 * cookie when the clearing Set-Cookie matches its path, and an old cookie at
 * the narrower path also shadows the site-wide one under /tools, so every
 * sign-in and sign-out clears this scope as well.
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

export const SIGN_IN_PATH = "/tools/feature-requests/sign-in";
export const PROJECTS_PATH = "/tools/feature-requests/projects";

export async function getFrUser(request: Request): Promise<FrUser | null> {
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

/** Loader/action guard: returns the user or redirects to a sign-in page with a return path. */
export async function requireFrUser(request: Request, signInPath: string = SIGN_IN_PATH): Promise<FrUser> {
  const user = await getFrUser(request);
  if (user) return user;
  const url = new URL(request.url);
  const next = url.pathname + url.search;
  throw redirect(`${signInPath}?next=${encodeURIComponent(next)}`);
}

/** Headers that set the session for a freshly authenticated identity (and clear the legacy-path cookie). */
export async function frSignInHeaders(identity: AnvilIdentity, tokens: AnvilTokens): Promise<Headers> {
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
export async function frSignOutHeaders(): Promise<Headers> {
  const headers = new Headers();
  headers.append("Set-Cookie", await cookie().serialize("", { maxAge: 0 }));
  headers.append("Set-Cookie", await legacyCookie().serialize("", { maxAge: 0 }));
  return headers;
}

/** Only allow same-site relative `next` targets inside the tool's areas. */
export function safeNext(value: string | null | undefined, fallback = PROJECTS_PATH): string {
  if (!value) return fallback;
  if (!value.startsWith("/tools/feature-requests") && !value.startsWith("/project")) return fallback;
  if (value.startsWith("//")) return fallback;
  return value;
}
