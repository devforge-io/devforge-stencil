import { getVisitor, isVisitorRegistrationEnabled } from "~/lib/visitor.server";
import type { Route } from "./+types/route";

// GET /api/visitor — current visitor identity (or null) + capability flags.
export async function loader({ request }: Route.LoaderArgs) {
  const visitor = await getVisitor(request);
  return Response.json({ visitor, registrationEnabled: isVisitorRegistrationEnabled() });
}
