/** POST /tools/feature-requests/sign-out clears the tool's session cookie. */

import { redirect, type ActionFunctionArgs } from "react-router";
import { validateCsrf } from "~/lib/csrf.server";
import { frSignOutHeaders } from "~/lib/feature-requests/session.server";
import { TOOL_PATH } from "~/components/tools/feature-requests/shell";

export async function loader() {
  return redirect(TOOL_PATH);
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  await validateCsrf(request, form);
  return redirect(TOOL_PATH, { headers: await frSignOutHeaders() });
}
