import { getSession, commitSession, getTokenBundle, setTokenBundle } from "./auth.server";
import { refreshAccessToken } from "./oauth.server";

/**
 * Resolve the GitHub token to use for this request. A configured service token
 * (GITHUB_TOKEN) always wins; otherwise the signed-in user's OAuth token, which
 * is refreshed and re-persisted if it has expired. Returns "" (unauthenticated)
 * when neither is available — e.g. an anonymous visitor reading a public repo.
 */
export async function resolveRequestToken(
  request: Request
): Promise<{ token: string; setCookie?: string }> {
  const envToken = process.env.GITHUB_TOKEN;
  if (envToken) return { token: envToken };

  const session = await getSession(request);
  const bundle = getTokenBundle(session);
  if (!bundle) return { token: "" };

  // Refresh a little before expiry so an in-flight request doesn't race it.
  const expiring =
    bundle.accessExpiresAt !== undefined && bundle.accessExpiresAt - 60_000 <= Date.now();
  if (expiring && bundle.refreshToken) {
    const refreshed = await refreshAccessToken(bundle.refreshToken);
    if (!refreshed) return { token: "" }; // refresh failed → unauthenticated
    setTokenBundle(session, refreshed);
    return { token: refreshed.accessToken, setCookie: await commitSession(session) };
  }
  return { token: bundle.accessToken };
}
