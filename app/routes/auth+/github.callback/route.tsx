import { redirect } from "react-router";
import { getSession, commitSession, roleFromGitHubPermission, setTokenBundle } from "~/lib/auth.server";
import { exchangeCodeForToken } from "~/lib/oauth.server";
import { CMS_LOGIN_PATH } from "~/lib/login-url";
import { getGitHubUserFromToken, getUserRepoPermission } from "~/lib/github.server";
import type { Route } from "./+types/route";

/** GET /auth/github/callback — finish the flow: verify state, resolve the user's
 * repo role, and start a session (or bounce back to /content/login with an error). */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const session = await getSession(request);
  const savedState = session.get("oauth_state");

  if (!code || !state || !savedState || state !== savedState) {
    return redirect(`${CMS_LOGIN_PATH}?error=state`);
  }
  session.unset("oauth_state");

  const bundle = await exchangeCodeForToken(code, `${url.origin}/auth/github/callback`);
  if (!bundle) return redirect(`${CMS_LOGIN_PATH}?error=oauth`);

  const ghUser = await getGitHubUserFromToken(bundle.accessToken);
  if (!ghUser) return redirect(`${CMS_LOGIN_PATH}?error=oauth`);

  // Check the user's repo role with their own token, so it works even when no
  // service GITHUB_TOKEN is configured.
  const permission = await getUserRepoPermission(ghUser.login, bundle.accessToken);
  const role = roleFromGitHubPermission(permission);
  if (!role) return redirect(`${CMS_LOGIN_PATH}?error=access`);

  session.set("username", ghUser.login);
  session.set("role", role);
  session.set("avatarUrl", ghUser.avatarUrl);
  // Persist the credentials so git operations can act as this user when there's
  // no service token. Harmless when GITHUB_TOKEN is set (it takes precedence).
  setTokenBundle(session, bundle);
  return redirect("/content", {
    headers: { "Set-Cookie": await commitSession(session) },
  });
}
