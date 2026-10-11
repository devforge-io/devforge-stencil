/**
 * The tool's sign-out moved to /account/sign-out. This stays so the sign-out
 * form in an already-open tab still works after a deploy.
 */

import { redirect, type ActionFunctionArgs } from "react-router";
import { validateCsrf } from "~/lib/csrf.server";
import { accountSignOutHeaders } from "~/lib/account/session.server";
import { ACCOUNT_PATH } from "~/lib/account/paths";
import { TOOL_PATH } from "~/components/tools/feature-requests/shell";

export async function loader() {
  return redirect(ACCOUNT_PATH);
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  await validateCsrf(request, form);
  return redirect(TOOL_PATH, { headers: await accountSignOutHeaders() });
}
