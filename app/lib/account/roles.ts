/**
 * Devforge's own account roles. These are the site's roles, not Anvil's: Anvil
 * has server roles (admin, user) and app member privileges (admin, editor,
 * reader), and neither says anything about what a person is to Devforge. Anvil
 * authenticates the person; devforge.io decides what they may do here.
 *
 * Roles are rows in the Anvil collection `app_devforge.roles`, keyed by a
 * UUID, so admins can add more without a deploy; an account's role is a
 * `role_id` pointing at one of them (accounts.server.ts). Code never hard-codes
 * a UUID: each role also carries a stable `slug`, and permission checks,
 * the session cookie and this module speak in slugs. Three are built in and
 * seeded on first use:
 *
 *   admin    Devforge staff: manages people and roles, sees everything.
 *   client   A Devforge client: gets the client-only areas as they are added.
 *   member   Everyone else with an account, the default when no role is set.
 *
 * Plain module, no server-only imports, so route components can use it.
 */

/** A role's stable machine name (`admin`, `client`, `member`, `partner-agency`). */
export type RoleSlug = string;

export type RoleDef = {
  /** UUID, the row key in app_devforge.roles and the value of accounts.role_id. */
  id: string;
  slug: RoleSlug;
  name: string;
  description: string;
  /** Seeded by the code; comes back if removed. */
  builtin: boolean;
};

export const ADMIN_ROLE: RoleSlug = "admin";
export const DEFAULT_ROLE: RoleSlug = "member";

export const BUILTIN_ROLES: readonly Omit<RoleDef, "id">[] = [
  { slug: "admin", name: "Admin", description: "Devforge staff. Manages people and roles and sees every account.", builtin: true },
  { slug: "client", name: "Client", description: "A Devforge client. Gets the client-only areas of the site.", builtin: true },
  { slug: "member", name: "Member", description: "Everyone with an account. The default when no role is set.", builtin: true },
];

const ROLE_SLUG = /^[a-z][a-z0-9_-]{0,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRoleSlug(value: unknown): value is RoleSlug {
  return typeof value === "string" && ROLE_SLUG.test(value);
}

export function isRoleId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** The slug a new role gets from its display name: `Partner agency` -> `partner-agency`. */
export function roleSlugFromName(name: string): RoleSlug | null {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return isRoleSlug(slug) ? slug : null;
}

/** Admins pass every check; everyone else needs their role in `allowed`. Slugs on both sides. */
export function roleAllows(role: RoleSlug, allowed: readonly RoleSlug[]): boolean {
  return role === ADMIN_ROLE || allowed.includes(role);
}
