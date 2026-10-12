/**
 * Devforge's own account roles. These are the site's roles, not Anvil's: Anvil
 * has server roles (admin, user) and app member privileges (admin, editor,
 * reader), and neither says anything about what a person is to Devforge. Anvil
 * authenticates the person; devforge.io decides what they may do here.
 *
 *   admin    Devforge staff: manages people and roles, sees everything.
 *   client   A Devforge client: gets the client-only areas as they are added.
 *   member   Everyone else with an account, the default on sign-up.
 *
 * Plain module, no server-only imports, so route components can use it. The
 * stored role lives in Anvil's document store (accounts.server.ts) and a
 * snapshot travels in the session cookie (session.server.ts).
 */

export const ACCOUNT_ROLES = ["admin", "client", "member"] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];
export const DEFAULT_ROLE: AccountRole = "member";

export function isAccountRole(value: unknown): value is AccountRole {
  return typeof value === "string" && (ACCOUNT_ROLES as readonly string[]).includes(value);
}

/** Admins pass every check; everyone else needs their role in `allowed`. */
export function roleAllows(role: AccountRole, allowed: readonly AccountRole[]): boolean {
  return role === "admin" || allowed.includes(role);
}

export const ROLE_INFO: Record<AccountRole, { label: string; summary: string }> = {
  admin: { label: "Admin", summary: "Devforge staff. Manages people and roles and sees every account." },
  client: { label: "Client", summary: "A Devforge client. Gets the client-only areas of the site." },
  member: { label: "Member", summary: "Everyone with an account. The default for a new sign-up." },
};
