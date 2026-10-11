import { redirect } from "react-router";
import { isAuthenticated } from "~/lib/auth.server";
import { CmsLoginCard } from "~/components/cms-login";
import type { Route } from "./+types/route";

/**
 * /content/login: GitHub sign-in for the CMS. Unlike /login, this ignores the
 * `loginUrl` setting, so admins can always reach it. The auth helper and the
 * OAuth callback send people here.
 */
export async function loader({ request }: Route.LoaderArgs) {
  if (await isAuthenticated(request)) throw redirect("/content");
  return null;
}

export default function CmsLogin() {
  return <CmsLoginCard />;
}
