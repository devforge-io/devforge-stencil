/**
 * Devforge's own account roles. These are the site's roles, not Anvil's: Anvil
 * has server roles (admin, user) and app member privileges (admin, editor,
 * reader), and neither says anything about what a person is to Devforge. Anvil
 * authenticates the person; devforge.io decides what they may do here.
 *
 * Roles are rows in the Anvil collection `app_devforge.roles` (key = role id),
 * so admins can add more without a deploy; an account's role is a `role_id`
 * pointing at one of them (accounts.server.ts). Three are built in and seeded:
 *
 *   admin    Devforge staff: manages people and roles, sees everything.
 *   client   A Devforge client: gets the client-only areas as they are added.
 *   member   Everyone else with an account, the default when no role is set.
 *
 * Plain module, no server-only imports, so route components can use it.
 */

/** A role id: the key of its row in app_devforge.roles. */
export type RoleId = string;

export type RoleDef = {
  id: RoleId;
  name: string;
  description: string;
  /** Seeded by the code; cannot be removed. */
  builtin: boolean;
};

export const ADMIN_ROLE: RoleId = "admin";
export const DEFAULT_ROLE: RoleId = "member";

export const BUILTIN_ROLES: readonly RoleDef[] = [
  { id: "admin", name: "Admin", description: "Devforge staff. Manages people and roles and sees every account.", builtin: true },
  { id: "client", name: "Client", description: "A Devforge client. Gets the client-only areas of the site.", builtin: true },
  { id: "member", name: "Member", description: "Everyone with an account. The default when no role is set.", builtin: true },
];

const ROLE_ID = /^[a-z][a-z0-9_-]{0,31}$/;

export function isRoleId(value: unknown): value is RoleId {
  return typeof value === "string" && ROLE_ID.test(value);
}

/** The id a new role gets from its display name: `Partner agency` -> `partner-agency`. */
export function roleIdFromName(name: string): RoleId | null {
  const id = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return isRoleId(id) ? id : null;
}

/** Admins pass every check; everyone else needs their role in `allowed`. */
export function roleAllows(role: RoleId, allowed: readonly RoleId[]): boolean {
  return role === ADMIN_ROLE || allowed.includes(role);
}
