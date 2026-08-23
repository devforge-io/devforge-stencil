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

/** Loader/action guard: returns the user or redirects to sign-in with a return path. */
export async function requireFrUser(request: Request): Promise<FrUser> {
  const user = await getFrUser(request);
  if (user) return user;
  const url = new URL(request.url);
  const next = url.pathname + url.search;
  throw redirect(`${SIGN_IN_PATH}?next=${encodeURIComponent(next)}`);
}

/** Set-Cookie value for a freshly authenticated identity. */
export async function createFrSession(identity: AnvilIdentity, tokens: AnvilTokens): Promise<string> {
  const payload: SessionPayload = {
    id: identity.sub,
    email: identity.email || identity.username,
    username: identity.username,
    iat: Date.now(),
    rt: tokens.refreshToken,
  };
  return cookie().serialize(payload);
}

export async function destroyFrSession(): Promise<string> {
  return cookie().serialize("", { maxAge: 0 });
}

/** Only allow same-site relative `next` targets. */
export function safeNext(value: string | null | undefined, fallback = PROJECTS_PATH): string {
  if (!value) return fallback;
  if (!value.startsWith("/tools/feature-requests")) return fallback;
  if (value.startsWith("//")) return fallback;
  return value;
}
