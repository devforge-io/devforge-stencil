/**
 * URL constants and the return-path guard for the site-wide Devforge account
 * (Anvil-backed). Plain module, no server-only imports, so route components
 * can build links. The cookie lives in ./session.server.ts.
 */

export const ACCOUNT_PATH = "/account";
export const SIGN_IN_PATH = "/account/sign-in";
export const SIGN_UP_PATH = "/account/sign-up";
export const SIGN_OUT_PATH = "/account/sign-out";
/** Admin-only: everyone with an account and their Devforge role. */
export const PEOPLE_PATH = "/account/people";
/** JSON: who is signed in, for the header's profile menu. */
export const ME_PATH = "/account/me";

/** Pages that must never be a post-sign-in destination: they would bounce straight back (or show JSON). */
const NO_RETURN = new Set([SIGN_IN_PATH, SIGN_UP_PATH, SIGN_OUT_PATH, ME_PATH, "/login", "/logout"]);

/**
 * Only same-site relative paths are allowed as a return target, and never one
 * of the auth pages themselves. Anything else falls back (default: /account).
 */
export function safeNext(value: string | null | undefined, fallback: string = ACCOUNT_PATH): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return fallback;
  const path = value.split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";
  if (NO_RETURN.has(path)) return fallback;
  return value;
}

/** Link to the sign-in page that returns to `next` afterwards, optionally with the email prefilled. */
export function signInHref(next?: string | null, email?: string | null): string {
  return withParams(SIGN_IN_PATH, { next, email });
}

/** Link to the sign-up page that returns to `next` afterwards. */
export function signUpHref(next?: string | null): string {
  return withParams(SIGN_UP_PATH, { next });
}

function withParams(path: string, params: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}
