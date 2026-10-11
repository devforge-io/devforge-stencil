/**
 * POST /account/sign-out clears the account session and returns to `next`
 * (a same-site path, default home). GET just shows the account page.
 */

import { redirect, type ActionFunctionArgs } from "react-router";
import { validateCsrf } from "~/lib/csrf.server";
import { accountSignOutHeaders } from "~/lib/account/session.server";
import { ACCOUNT_PATH, safeNext } from "~/lib/account/paths";

export async function loader() {
  return redirect(ACCOUNT_PATH);
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  await validateCsrf(request, form);
  return redirect(safeNext(String(form.get("next") ?? ""), "/"), { headers: await accountSignOutHeaders() });
}
