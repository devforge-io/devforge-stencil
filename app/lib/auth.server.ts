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
