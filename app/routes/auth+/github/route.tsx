import { redirect } from "react-router";
import { getSession, commitSession } from "~/lib/auth.server";
import { isOAuthConfigured, githubAuthorizeUrl } from "~/lib/oauth.server";
import type { Route } from "./+types/route";

/** GET /auth/github — start the GitHub OAuth flow. */
export async function loader({ request }: Route.LoaderArgs) {
  if (!isOAuthConfigured()) {
    throw new Response(
      "GitHub OAuth is not configured. Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET.",
      { status: 500 }
    );
  }
  const url = new URL(request.url);
  const state = crypto.randomUUID();
  const session = await getSession(request);
  session.set("oauth_state", state);
  const redirectUri = `${url.origin}/auth/github/callback`;
  return redirect(githubAuthorizeUrl(redirectUri, state), {
    headers: { "Set-Cookie": await commitSession(session) },
  });
}
