import { redirect } from "react-router";
import { getSession, destroySession } from "~/lib/auth.server";
import type { Route } from "./+types/route";

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request);
  return redirect("/", {
    headers: {
      "Set-Cookie": await destroySession(session),
    },
  });
}
