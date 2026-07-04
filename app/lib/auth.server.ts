import { createCookieSessionStorage, redirect } from "react-router";
import type { GitHubTokenBundle } from "./oauth.server";

type Session = Awaited<ReturnType<typeof getSession>>;

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

// --- GitHub token bundle (session) -------------------------------------------
// Stored so the user's own credentials can drive git operations when no service
// GITHUB_TOKEN is configured. The cookie is encrypted (httpOnly + secrets).

export function setTokenBundle(session: Session, bundle: GitHubTokenBundle): void {
  session.set("gh_at", bundle.accessToken);
  bundle.refreshToken ? session.set("gh_rt", bundle.refreshToken) : session.unset("gh_rt");
  bundle.accessExpiresAt ? session.set("gh_at_exp", bundle.accessExpiresAt) : session.unset("gh_at_exp");
  bundle.refreshExpiresAt ? session.set("gh_rt_exp", bundle.refreshExpiresAt) : session.unset("gh_rt_exp");
}

export function getTokenBundle(session: Session): GitHubTokenBundle | null {
  const accessToken = session.get("gh_at") as string | undefined;
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: session.get("gh_rt") as string | undefined,
    accessExpiresAt: session.get("gh_at_exp") as number | undefined,
    refreshExpiresAt: session.get("gh_rt_exp") as number | undefined,
  };
}

// --- Roles -------------------------------------------------------------------
// Derived from the signed-in user's permission on GITHUB_OWNER/GITHUB_REPO.

export type Role = "admin" | "moderator" | "editor";

const ROLE_RANK: Record<Role, number> = { editor: 1, moderator: 2, admin: 3 };

export interface AuthUser {
  username: string;
  role: Role;
  avatarUrl?: string;
}

/**
 * Map a GitHub repo role (`role_name`, or the coarser `permission`) to a CMS
 * role. Anything below write access → null (no CMS access).
 */
export function roleFromGitHubPermission(permission: string | null | undefined): Role | null {
  switch (permission) {
    case "admin":
      return "admin";
    case "maintain":
      return "moderator";
    case "write":
    case "push":
      return "editor";
    default:
      return null; // triage, read, none
  }
}

export function hasAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Capability matrix (admin ⊃ moderator ⊃ editor). */
export const can = {
  edit: (role: Role) => hasAtLeast(role, "editor"),
  publish: (role: Role) => hasAtLeast(role, "moderator"),
  remove: (role: Role) => hasAtLeast(role, "moderator"),
  manageSettings: (role: Role) => hasAtLeast(role, "admin"),
  manageVisitors: (role: Role) => hasAtLeast(role, "admin"),
};

export async function getAuthUser(request: Request): Promise<AuthUser | null> {
  const session = await getSession(request);
  const username = session.get("username");
  const role = session.get("role") as Role | undefined;
  if (!username || !role) return null;
  return { username, role, avatarUrl: session.get("avatarUrl") as string | undefined };
}

export async function requireAuth(request: Request): Promise<AuthUser> {
  const user = await getAuthUser(request);
  if (!user) {
    throw redirect("/login");
  }
  return user;
}

/** Require a minimum role; a signed-in user below it gets a 403. */
export async function requireRole(request: Request, min: Role): Promise<AuthUser> {
  const user = await requireAuth(request);
  if (!hasAtLeast(user.role, min)) {
    throw new Response(`Forbidden — this action requires the ${min} role.`, { status: 403 });
  }
  return user;
}

export async function isAuthenticated(request: Request): Promise<boolean> {
  return !!(await getAuthUser(request));
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
