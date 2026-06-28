import { authenticateVisitor, commitVisitorIdentity } from "~/lib/visitor.server";
import type { Route } from "./+types/route";

// POST /api/visitor/login — verify credentials and start a session.
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: { username?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const identity = await authenticateVisitor(body.username ?? "", body.password ?? "");
  if (!identity) {
    return Response.json({ error: "Invalid username or password" }, { status: 401 });
  }

  const cookie = await commitVisitorIdentity(request, identity);
  return Response.json({ ok: true, visitor: identity }, { headers: { "Set-Cookie": cookie } });
}
