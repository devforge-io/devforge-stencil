import { getAuthUser } from "~/lib/auth.server";
import type { Route } from "./+types/route";

/**
 * GET /api/me — the current CMS user's identity/role, or { role: null } if not
 * signed in. Used by public pages to reveal admin-only affordances (e.g. an Edit
 * button) client-side without making the cached page vary by auth. Never cached.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const user = await getAuthUser(request);
  return Response.json(
    user ? { username: user.username, role: user.role } : { role: null },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
