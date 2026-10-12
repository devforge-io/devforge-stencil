/**
 * Devforge roles and who holds them, in Anvil's document store under the
 * account app's schema (app_devforge, next to the licence records).
 *
 *   roles      key = role id      {id, name, description, builtin, created_by, created_at, updated_at}
 *   accounts   key = user id      {user_id, role_id, set_by, set_at, created_at, updated_at}
 *
 * Nothing about the person is copied here: email, username and last sign-in
 * stay in `auth.users`, and who has a Devforge account is the member list of
 * the account app (`auth.app_members`). An accounts row exists only once a
 * role has been assigned; no row means the default role (member). The three
 * built-in roles are seeded on first use and admins can add more. Addresses
 * listed in `ACCOUNT_ADMINS` are admins whatever the rows say, which is how
 * the first admin gets in.
 */

import { AnvilError, docEnsureCollection, docGet, docPut, docQuery, lookupUserIdByEmail, type AnvilDocument } from "../feature-requests/anvil.server";
import { listAccountAppMemberIds } from "./anvil-app.server";
import { ADMIN_ROLE, BUILTIN_ROLES, DEFAULT_ROLE, isRoleId, roleIdFromName, type RoleDef, type RoleId } from "./roles";

const ROLES = "app_devforge.roles";
const ACCOUNTS = "app_devforge.accounts";

export type AccountRecord = {
  /** Anvil user id (the JWT `sub`). */
  userId: string;
  roleId: RoleId;
  /** Who assigned the role (a user id, or `env` for the ACCOUNT_ADMINS bootstrap) and when (unix ms). */
  setBy: string;
  setAt: number;
  createdAt: number;
  updatedAt: number;
};

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/* ---------------------------------------------------------------------- */
/* Collections and seed                                                    */
/* ---------------------------------------------------------------------- */

let ready: Promise<void> | null = null;

async function seedRoles(): Promise<void> {
  const now = Date.now();
  for (const r of BUILTIN_ROLES) {
    try {
      await docPut(ROLES, r.id, { id: r.id, name: r.name, description: r.description, builtin: true, created_by: "seed", created_at: now, updated_at: now }, { ifNotExists: true });
    } catch (err) {
      if (err instanceof AnvilError && err.status === 409) continue;
      throw err;
    }
  }
}

function ensureReady(): Promise<void> {
  ready ??= Promise.all([docEnsureCollection(ROLES), docEnsureCollection(ACCOUNTS)])
    .then(seedRoles)
    .catch((err) => {
      ready = null;
      throw err;
    });
  return ready;
}

const CACHE_TTL = 60_000;
let rolesCache: { roles: RoleDef[]; expiresAt: number } | null = null;
const roleOfUser = new Map<string, { role: RoleId; expiresAt: number }>();

function rememberRole(userId: string, role: RoleId) {
  if (roleOfUser.size > 10_000) roleOfUser.clear();
  roleOfUser.set(userId, { role, expiresAt: Date.now() + CACHE_TTL });
}

/** For tests. */
export function resetAccountsCache(): void {
  ready = null;
  rolesCache = null;
  roleOfUser.clear();
}

/* ---------------------------------------------------------------------- */
/* Roles                                                                   */
/* ---------------------------------------------------------------------- */

function toRole(doc: AnvilDocument): RoleDef {
  const b = doc.body;
  return { id: str(b.id, doc.key), name: str(b.name, doc.key), description: str(b.description), builtin: b.builtin === true };
}

/** Every role, built-ins first in their canonical order, then the rest by name. Cached a minute. */
export async function listRoles(): Promise<RoleDef[]> {
  if (rolesCache && rolesCache.expiresAt > Date.now()) return rolesCache.roles;
  await ensureReady();
  const docs = await docQuery(ROLES, null, 1000);
  const order = new Map(BUILTIN_ROLES.map((r, i) => [r.id, i]));
  const roles = docs.map(toRole).sort((a, b) => {
    const ia = order.get(a.id) ?? 99;
    const ib = order.get(b.id) ?? 99;
    return ia - ib || a.name.localeCompare(b.name);
  });
  rolesCache = { roles, expiresAt: Date.now() + CACHE_TTL };
  return roles;
}

export async function getRole(id: RoleId): Promise<RoleDef | null> {
  if (!isRoleId(id)) return null;
  return (await listRoles()).find((r) => r.id === id) ?? null;
}

/** Name and description for a role id, falling back to the id itself when the row is gone or unreadable. */
export async function describeRole(id: RoleId): Promise<RoleDef> {
  try {
    const role = await getRole(id);
    if (role) return role;
  } catch (err) {
    console.error(`[account] could not read role ${id}: ${(err as Error).message}`);
  }
  return BUILTIN_ROLES.find((r) => r.id === id) ?? { id, name: id, description: "", builtin: false };
}

export type RoleCreate = { outcome: "created" | "exists" | "invalid"; role?: RoleDef; reason?: string };

/** Adds a role; its id comes from the name. */
export async function createRole(input: { name: string; description: string }, byUserId: string): Promise<RoleCreate> {
  const name = input.name.trim().replace(/\s+/g, " ");
  const description = input.description.trim();
  if (name.length < 2 || name.length > 40) return { outcome: "invalid", reason: "Give the role a name of 2 to 40 characters." };
  if (description.length > 200) return { outcome: "invalid", reason: "Keep the description under 200 characters." };
  const id = roleIdFromName(name);
  if (!id) return { outcome: "invalid", reason: "The name needs at least one letter." };
  await ensureReady();
  const now = Date.now();
  const role: RoleDef = { id, name, description, builtin: false };
  try {
    await docPut(ROLES, id, { id, name, description, builtin: false, created_by: byUserId, created_at: now, updated_at: now }, { ifNotExists: true });
  } catch (err) {
    if (err instanceof AnvilError && err.status === 409) return { outcome: "exists", role: (await getRole(id)) ?? role };
    throw err;
  }
  rolesCache = null;
  return { outcome: "created", role };
}

/* ---------------------------------------------------------------------- */
/* Who holds which role                                                    */
/* ---------------------------------------------------------------------- */

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Lower-cased addresses from `ACCOUNT_ADMINS` (comma, semicolon or whitespace separated). */
export function configuredAdmins(): Set<string> {
  return new Set(
    (process.env.ACCOUNT_ADMINS ?? "")
      .split(/[\s,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isConfiguredAdmin(email: string): boolean {
  const needle = email.trim().toLowerCase();
  return needle.length > 0 && configuredAdmins().has(needle);
}

/** The role that counts: the ACCOUNT_ADMINS list wins, then the assigned role, then member. */
export function effectiveRole(record: Pick<AccountRecord, "roleId"> | null, email: string): RoleId {
  if (isConfiguredAdmin(email)) return ADMIN_ROLE;
  return record?.roleId ?? DEFAULT_ROLE;
}

function toRecord(doc: AnvilDocument): AccountRecord {
  const b = doc.body;
  return {
    userId: str(b.user_id, doc.key),
    roleId: isRoleId(b.role_id) ? b.role_id : DEFAULT_ROLE,
    setBy: str(b.set_by),
    setAt: num(b.set_at),
    createdAt: num(b.created_at),
    updatedAt: num(b.updated_at),
  };
}

export async function getAccountRecord(userId: string): Promise<AccountRecord | null> {
  if (!USER_ID.test(userId)) return null;
  await ensureReady();
  const doc = await docGet(ACCOUNTS, userId);
  return doc ? toRecord(doc) : null;
}

/**
 * The role as assigned now (cached a minute), under the ACCOUNT_ADMINS
 * override. A role whose row has been removed counts as member. Guards use
 * this so a change made by an admin applies within a minute, not at the
 * person's next sign-in. Throws when Anvil cannot be read.
 */
export async function getAccountRole(userId: string, email: string): Promise<RoleId> {
  if (isConfiguredAdmin(email)) return ADMIN_ROLE;
  const cached = roleOfUser.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.role;
  const [record, roles] = await Promise.all([getAccountRecord(userId), listRoles()]);
  let role = effectiveRole(record, email);
  if (!roles.some((r) => r.id === role)) role = DEFAULT_ROLE;
  rememberRole(userId, role);
  return role;
}

/**
 * The role for a fresh session cookie. Never throws: when Anvil cannot be
 * read the person signs in with the role the environment alone can vouch for,
 * and the error is logged.
 */
export async function roleForSignIn(identity: { sub: string; email: string }): Promise<RoleId> {
  try {
    return await getAccountRole(identity.sub, identity.email);
  } catch (err) {
    console.error(`[account] could not read the role of ${identity.sub} at sign-in: ${(err as Error).message}`);
    return effectiveRole(null, identity.email);
  }
}

/** Assigns `roleId` to a user, creating or replacing their accounts row. The role must exist. */
export async function setAccountRole(userId: string, roleId: RoleId, byUserId: string): Promise<AccountRecord> {
  if (!USER_ID.test(userId)) throw new AnvilError("Invalid user id", 400);
  if (!(await getRole(roleId))) throw new AnvilError(`No role ${JSON.stringify(roleId)}`, 400);
  const existing = await getAccountRecord(userId);
  const now = Date.now();
  const next: AccountRecord = { userId, roleId, setBy: byUserId, setAt: now, createdAt: existing?.createdAt || now, updatedAt: now };
  await docPut(ACCOUNTS, userId, { user_id: userId, role_id: roleId, set_by: byUserId, set_at: now, created_at: next.createdAt, updated_at: now });
  roleOfUser.delete(userId);
  return next;
}

export type RoleChange = { outcome: "updated" | "unchanged" | "no_account"; record?: AccountRecord };

/** Assigns a role to whoever owns `email` in Anvil; `no_account` when nobody does. */
export async function assignRoleByEmail(email: string, roleId: RoleId, byUserId: string): Promise<RoleChange> {
  const needle = email.trim().toLowerCase();
  if (!needle) return { outcome: "no_account" };
  const userId = await lookupUserIdByEmail(needle);
  if (!userId) return { outcome: "no_account" };
  const existing = await getAccountRecord(userId);
  if (existing && existing.roleId === roleId) return { outcome: "unchanged", record: existing };
  return { outcome: "updated", record: await setAccountRole(userId, roleId, byUserId) };
}

/* ---------------------------------------------------------------------- */
/* People: members of the account app joined with auth.users               */
/* ---------------------------------------------------------------------- */

export type Person = {
  id: string;
  email: string;
  username: string;
  roleId: RoleId;
  /** Unix ms from auth.users, 0 when unknown. */
  lastSignedInAt: number;
  /** Explicitly assigned (an accounts row exists) rather than the default. */
  assigned: boolean;
  /** Admin through ACCOUNT_ADMINS whatever the row says. */
  pinned: boolean;
};

async function usersById(ids: string[]): Promise<Map<string, { email: string; username: string; lastSignedInAt: number }>> {
  const out = new Map<string, { email: string; username: string; lastSignedInAt: number }>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const docs = await docQuery("auth.users", { op: "in", field: "id", values: chunk }, chunk.length);
    for (const d of docs) {
      const id = str(d.body.id, d.key);
      out.set(id, { email: str(d.body.email).toLowerCase(), username: str(d.body.username), lastSignedInAt: num(d.body.last_signed_in_on) });
    }
  }
  return out;
}

/**
 * Everyone with a Devforge account: members of the account app plus anyone
 * holding an assigned role, with email and username from auth.users and the
 * role they effectively hold. Most recent sign-in first.
 */
export async function listPeople(): Promise<Person[]> {
  await ensureReady();
  const [memberIds, rows] = await Promise.all([listAccountAppMemberIds(), docQuery(ACCOUNTS, null, 10_000)]);
  const records = new Map(rows.map(toRecord).map((r) => [r.userId, r]));
  const ids = [...new Set([...memberIds, ...records.keys()])];
  const users = await usersById(ids);
  return ids
    .map((id): Person => {
      const u = users.get(id);
      const rec = records.get(id) ?? null;
      const email = u?.email ?? "";
      return {
        id,
        email,
        username: u?.username ?? "",
        roleId: effectiveRole(rec, email),
        lastSignedInAt: u?.lastSignedInAt ?? 0,
        assigned: rec !== null,
        pinned: isConfiguredAdmin(email),
      };
    })
    .sort((a, b) => b.lastSignedInAt - a.lastSignedInAt || a.email.localeCompare(b.email));
}
