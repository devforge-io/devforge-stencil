/**
 * GitHub OAuth (web application flow) for CMS sign-in. Identity only — the role
 * is derived separately from repo permission, and git operations keep using the
 * app token (GITHUB_TOKEN). Requires a GitHub OAuth App:
 *   GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET
 * with callback `<origin>/auth/github/callback`.
 */

export function isOAuthConfigured(): boolean {
  return !!(process.env.GITHUB_OAUTH_CLIENT_ID && process.env.GITHUB_OAUTH_CLIENT_SECRET);
}

/** The GitHub authorize URL to redirect the browser to. `scope=read:user` is
 * enough — repo permission is checked server-side with the app token. */
export function githubAuthorizeUrl(redirectUri: string, state: string): string {
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", process.env.GITHUB_OAUTH_CLIENT_ID ?? "");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", "read:user");
  u.searchParams.set("state", state);
  u.searchParams.set("allow_signup", "false");
  return u.toString();
}

/** Exchange an authorization code for a user access token (or null on failure). */
export async function exchangeCodeForToken(code: string, redirectUri: string): Promise<string | null> {
  try {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: process.env.GITHUB_OAUTH_CLIENT_ID,
        client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: string };
    return typeof data.access_token === "string" ? data.access_token : null;
  } catch {
    return null;
  }
}
