import {
  registerVisitor,
  commitVisitorIdentity,
  isVisitorRegistrationEnabled,
  VisitorError,
} from "~/lib/visitor.server";
import type { Route } from "./+types/route";

// POST /api/visitor/register — create a visitor account and start a session.
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (!isVisitorRegistrationEnabled()) {
    return Response.json({ error: "Registration is disabled" }, { status: 403 });
  }

  let body: { username?: string; password?: string; attributes?: Record<string, unknown>; roles?: string[] };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const identity = await registerVisitor({
      username: body.username ?? "",
      password: body.password ?? "",
      attributes: body.attributes,
      roles: body.roles,
    });
    const cookie = await commitVisitorIdentity(request, identity);
    return Response.json({ ok: true, visitor: identity }, { headers: { "Set-Cookie": cookie } });
  } catch (e) {
    if (e instanceof VisitorError) return Response.json({ error: e.message }, { status: 400 });
    console.error("[visitor] register failed:", e);
    return Response.json({ error: "Registration failed" }, { status: 500 });
  }
}
