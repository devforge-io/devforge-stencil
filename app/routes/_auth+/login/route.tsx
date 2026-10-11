import { redirect } from "react-router";
import { isAuthenticated } from "~/lib/auth.server";
import { getSettings } from "~/lib/settings.server";
import { normalizeLoginUrl, withNext } from "~/lib/login-url";
import { CmsLoginCard } from "~/components/cms-login";
import type { Route } from "./+types/route";

/**
 * /login: the site's sign-in entry point.
 *
 * By default this is the GitHub sign-in for the CMS. A site that has its own
 * accounts sets `loginUrl` in settings.json (Settings > General) and visitors
 * are sent there instead; CMS admins then sign in at /content/login, which the
 * setting never touches. An unreadable settings file falls back to the default.
 */
export async function loader({ request }: Route.LoaderArgs) {
  if (await isAuthenticated(request)) throw redirect("/content");
  const loginUrl = await configuredLoginUrl();
  if (loginUrl) {
    const next = new URL(request.url).searchParams.get("next");
    throw redirect(withNext(loginUrl, next));
  }
  return null;
}

async function configuredLoginUrl(): Promise<string | null> {
  try {
    const { settings } = await getSettings();
    return normalizeLoginUrl(settings.loginUrl);
  } catch {
    return null;
  }
}

export default function Login() {
  return <CmsLoginCard />;
}
