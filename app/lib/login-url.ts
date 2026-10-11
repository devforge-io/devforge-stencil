/**
 * The `loginUrl` setting: where `/login` sends site visitors when a site
 * replaces Stencil's GitHub sign-in with its own (visitor accounts, a route
 * added in a fork, an external identity provider).
 *
 * CMS admins keep signing in at CMS_LOGIN_PATH, which ignores the setting, so
 * a wrong value can only ever affect visitors, never lock admins out.
 *
 * Plain module (no server-only imports) so route components can link to
 * CMS_LOGIN_PATH as well.
 */

/** GitHub sign-in for the CMS. Fixed; not configurable. */
export const CMS_LOGIN_PATH = "/content/login";

/**
 * Validate a configured login URL. Accepts a path on this site (one leading
 * slash) or an absolute http(s) URL. Returns the trimmed value, or null when
 * blank or unusable. `/login` itself is rejected because it would loop.
 */
export function normalizeLoginUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(v)) return null;

  if (v.startsWith("/")) {
    if (v.startsWith("//")) return null; // protocol-relative: an off-site URL in disguise
    const path = v.split(/[?#]/, 1)[0].replace(/\/+$/, "");
    if (path === "/login") return null;
    return v;
  }

  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return v;
}

/**
 * Append a `next` return path to a login URL. Only same-site paths are
 * forwarded; anything else is dropped so the target never receives an
 * off-site redirect hint.
 */
export function withNext(loginUrl: string, next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return loginUrl;
  const hashAt = loginUrl.indexOf("#");
  const base = hashAt === -1 ? loginUrl : loginUrl.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : loginUrl.slice(hashAt);
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}next=${encodeURIComponent(next)}${hash}`;
}
