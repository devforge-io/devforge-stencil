import { redirect } from "react-router";
import { getSession, commitSession, roleFromGitHubPermission } from "~/lib/auth.server";
import { exchangeCodeForToken } from "~/lib/oauth.server";
import { getGitHubUserFromToken, getUserRepoPermission } from "~/lib/github.server";
import type { Route } from "./+types/route";

/** GET /auth/github/callback — finish the flow: verify state, resolve the user's
 * repo role, and start a session (or bounce back to /login with an error). */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const session = await getSession(request);
  const savedState = session.get("oauth_state");

  if (!code || !state || !savedState || state !== savedState) {
    return redirect("/login?error=state");
  }
  session.unset("oauth_state");

  const token = await exchangeCodeForToken(code, `${url.origin}/auth/github/callback`);
  if (!token) return redirect("/login?error=oauth");

  const ghUser = await getGitHubUserFromToken(token);
  if (!ghUser) return redirect("/login?error=oauth");

  const permission = await getUserRepoPermission(ghUser.login);
  const role = roleFromGitHubPermission(permission);
  if (!role) return redirect("/login?error=access");

  session.set("username", ghUser.login);
  session.set("role", role);
  session.set("avatarUrl", ghUser.avatarUrl);
  return redirect("/content", {
    headers: { "Set-Cookie": await commitSession(session) },
  });
}
