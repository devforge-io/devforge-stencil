import { createCookieSessionStorage, redirect } from "react-router";

const sessionSecret = process.env.SESSION_SECRET || "dev-secret-change-me";

const sessionStorage = createCookieSessionStorage({
  cookie: {
    name: "__stencil_session",
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 7, // 1 week
    path: "/",
    sameSite: "lax",
    secrets: [sessionSecret],
    secure: process.env.NODE_ENV === "production",
  },
});

export async function getSession(request: Request) {
  return sessionStorage.getSession(request.headers.get("Cookie"));
}

export async function commitSession(
  session: Awaited<ReturnType<typeof getSession>>
) {
  return sessionStorage.commitSession(session);
}

export async function destroySession(
  session: Awaited<ReturnType<typeof getSession>>
) {
  return sessionStorage.destroySession(session);
}

export async function requireAuth(request: Request) {
  const session = await getSession(request);
  const username = session.get("username");

  if (!username) {
    throw redirect("/login");
  }

  return { username: username as string };
}

export async function isAuthenticated(request: Request): Promise<boolean> {
  const session = await getSession(request);
  return !!session.get("username");
}

/**
 * Validate API access. If API_TOKEN is set in env, requests must include
 * either `Authorization: Bearer <token>` header or `?token=<token>` query param.
 * If API_TOKEN is not set, all requests are allowed (public API).
 *
 * Returns null if authorized, or a Response to return if unauthorized.
 */
export function requireApiToken(request: Request): Response | null {
  const apiToken = process.env.API_TOKEN;

  // If no token configured, API is public
  if (!apiToken) return null;

  // Check Authorization header
  const authHeader = request.headers.get("Authorization");
  if (authHeader) {
    const [scheme, token] = authHeader.split(" ", 2);
    if (scheme?.toLowerCase() === "bearer" && token === apiToken) {
      return null;
    }
  }

  // Check query param
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token");
  if (queryToken === apiToken) {
    return null;
  }

  return Response.json(
    { error: "Unauthorized. Provide a valid API token via Authorization: Bearer <token> header or ?token= query parameter." },
    {
      status: 401,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "WWW-Authenticate": "Bearer",
      },
    }
  );
}
