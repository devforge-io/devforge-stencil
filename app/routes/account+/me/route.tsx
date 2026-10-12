/**
 * GET /account/me: who is signed in, as JSON, for the profile menu the CMS
 * header renders with a small script. Pages are cached at the edge for
 * everyone, so the header itself is static and asks this endpoint, which is
 * never cached and varies by cookie. Signed in, it also hands out the CSRF
 * token the menu's sign-out form needs. Same-origin only; no CORS headers.
 */

import type { LoaderFunctionArgs } from "react-router";
import { ensureCsrfToken } from "~/lib/csrf.server";
import { accountHintClearHeader, currentRole, getAccountUser } from "~/lib/account/session.server";
import { ACCOUNT_PATH, PEOPLE_PATH, SIGN_IN_PATH, SIGN_OUT_PATH } from "~/lib/account/paths";
import { ADMIN_ROLE } from "~/lib/account/roles";
import { describeRole } from "~/lib/account/accounts.server";
import { LICENSES_PATH } from "~/lib/licensing/shared";

const NO_STORE = { "Cache-Control": "no-store", Vary: "Cookie" };

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await getAccountUser(request);
  if (!user) {
    const headers = new Headers(NO_STORE);
    // A stale hint cookie would make the header draw a profile button for nobody.
    if (/(^|;\s*)df_account=/.test(request.headers.get("Cookie") ?? "")) headers.append("Set-Cookie", await accountHintClearHeader());
    return Response.json({ signedIn: false, signIn: SIGN_IN_PATH }, { headers });
  }
  const [{ token, setCookie }, slug] = await Promise.all([ensureCsrfToken(request), currentRole(user)]);
  const role = await describeRole(slug);
  const headers = new Headers(NO_STORE);
  if (setCookie) headers.append("Set-Cookie", setCookie);
  return Response.json(
    {
      signedIn: true,
      user: { username: user.username, email: user.email, role: { slug: role.slug, name: role.name } },
      links: { account: ACCOUNT_PATH, licenses: LICENSES_PATH, people: role.slug === ADMIN_ROLE ? PEOPLE_PATH : null, signOut: SIGN_OUT_PATH },
      csrf: token,
    },
    { headers },
  );
}
