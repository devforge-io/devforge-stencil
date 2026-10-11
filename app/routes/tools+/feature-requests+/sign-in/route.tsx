/**
 * /tools/feature-requests/sign-in moved to /account/sign-in (the site-wide
 * Devforge account). Kept as a redirect so old links keep working; without a
 * return path, people land on their projects as before.
 */

import { redirect, type LoaderFunctionArgs } from "react-router";
import { safeNext, signInHref } from "~/lib/account/paths";
import { PROJECTS_PATH } from "~/components/tools/feature-requests/shell";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  return redirect(signInHref(safeNext(url.searchParams.get("next"), PROJECTS_PATH), url.searchParams.get("email")), 301);
}
