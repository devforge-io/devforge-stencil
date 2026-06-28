import { destroyVisitorSession } from "~/lib/visitor.server";
import type { Route } from "./+types/route";

// POST /api/visitor/logout — clear the visitor session.
export async function action({ request }: Route.ActionArgs) {
  const cookie = await destroyVisitorSession(request);
  return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie } });
}
