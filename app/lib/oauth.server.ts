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

const TOKEN_URL = "https://github.com/login/oauth/access_token";

/**
 * A user's GitHub credentials. GitHub Apps with "expire user authorization
 * tokens" enabled return short-lived access tokens (~8h) plus a rotating refresh
 * token (~6mo); apps without expiry return just an access token.
 */
export interface GitHubTokenBundle {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires (undefined ⇒ never). */
  accessExpiresAt?: number;
  /** Epoch ms when the refresh token expires. */
  refreshExpiresAt?: number;
}

function bundleFromResponse(data: unknown): GitHubTokenBundle | null {
  const d = data as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
  };
  if (typeof d.access_token !== "string") return null;
  const now = Date.now();
  return {
    accessToken: d.access_token,
    refreshToken: typeof d.refresh_token === "string" ? d.refresh_token : undefined,
    accessExpiresAt: typeof d.expires_in === "number" ? now + d.expires_in * 1000 : undefined,
    refreshExpiresAt:
      typeof d.refresh_token_expires_in === "number" ? now + d.refresh_token_expires_in * 1000 : undefined,
  };
}

async function postToken(body: Record<string, string>): Promise<GitHubTokenBundle | null> {
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return bundleFromResponse(await res.json());
  } catch {
    return null;
  }
}

/** Exchange an authorization code for the user's token bundle (or null). */
export function exchangeCodeForToken(code: string, redirectUri: string): Promise<GitHubTokenBundle | null> {
  return postToken({
    client_id: process.env.GITHUB_OAUTH_CLIENT_ID ?? "",
    client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET ?? "",
    code,
    redirect_uri: redirectUri,
  });
}

/** Trade a refresh token for a fresh bundle (the refresh token rotates). */
export function refreshAccessToken(refreshToken: string): Promise<GitHubTokenBundle | null> {
  return postToken({
    client_id: process.env.GITHUB_OAUTH_CLIENT_ID ?? "",
    client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET ?? "",
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}
