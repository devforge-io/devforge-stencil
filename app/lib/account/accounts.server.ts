/**
 * Devforge roles and who holds them, in Anvil's document store under the
 * account app's schema (app_devforge, next to the licence records).
 *
 *   roles      key = role id (UUID)   {id, slug, name, description, builtin, created_by, created_at, updated_at}
 *   accounts   key = user id          {user_id, role_id, set_by, set_at, created_at, updated_at}
 *
 * Nothing about the person is copied here: email, username and last sign-in
 * stay in `auth.users`, and who has a Devforge account is the member list of
 * the account app (`auth.app_members`). An accounts row exists only once a
 * role has been assigned; no row means the default role (member). Rows are
 * linked by the role's UUID; code reasons in the role's `slug` (roles.ts), so
 * everything here resolves one to the other. The three built-in roles are
 * seeded on first use and admins can add more. Addresses listed in
 * `ACCOUNT_ADMINS` are admins whatever the rows say, which is how the first
 * admin gets in.
 */

import { randomUUID } from "node:crypto";
import { AnvilError, docEnsureCollection, docGet, docPut, docQuery, lookupUserIdByEmail, type AnvilDocument } from "../feature-requests/anvil.server";
import { listAccountAppMemberIds } from "./anvil-app.server";
import { ADMIN_ROLE, BUILTIN_ROLES, DEFAULT_ROLE, isRoleId, isRoleSlug, roleSlugFromName, type RoleDef, type RoleSlug } from "./roles";

const ROLES = "app_devforge.roles";
const ACCOUNTS = "app_devforge.accounts";

export type AccountRecord = {
  /** Anvil user id (the JWT `sub`). */
  userId: string;
  /** UUID of the role row. */
  roleId: string;
  /** Who assigned the role (a user id) and when (unix ms). */
  setBy: string;
  setAt: number;
  createdAt: number;
  updatedAt: number;
};

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/* ---------------------------------------------------------------------- */
/* Collections, seed, caches                                               */
/* ---------------------------------------------------------------------- */

let collectionsReady: Promise<void> | null = null;

function ensureCollections(): Promise<void> {
  collectionsReady ??= Promise.all([docEnsureCollection(ROLES), docEnsureCollection(ACCOUNTS)])
    .then(() => undefined)
    .catch((err) => {
      collectionsReady = null;
      throw err;
    });
  return collectionsReady;
}

const CACHE_TTL = 60_000;
let rolesCache: { roles: RoleDef[]; expiresAt: number } | null = null;
let rolesLoading: Promise<RoleDef[]> | null = null;
const roleOfUser = new Map<string, { role: RoleSlug; expiresAt: number }>();

function rememberRole(userId: string, role: RoleSlug) {
  if (roleOfUser.size > 10_000) roleOfUser.clear();
  roleOfUser.set(userId, { role, expiresAt: Date.now() + CACHE_TTL });
}

/** For tests. */
export function resetAccountsCache(): void {
  collectionsReady = null;
  rolesCache = null;
  rolesLoading = null;
  roleOfUser.clear();
}

/* ---------------------------------------------------------------------- */
/* Roles                                                                   */
/* ---------------------------------------------------------------------- */

/** A role row, or null for a row this code does not understand (no slug, or a non-UUID key). */
function toRole(doc: AnvilDocument): RoleDef | null {
  const b = doc.body;
  const id = str(b.id, doc.key);
  if (!isRoleId(id) || !isRoleSlug(b.slug)) return null;
  return { id, slug: b.slug, name: str(b.name, b.slug), description: str(b.description), builtin: b.builtin === true };
}

function roleBody(role: RoleDef, createdBy: string, now: number): Record<string, unknown> {
  return { id: role.id, slug: role.slug, name: role.name, description: role.description, builtin: role.builtin, created_by: createdBy, created_at: now, updated_at: now };
}

function sortRoles(roles: RoleDef[]): RoleDef[] {
  const order = new Map(BUILTIN_ROLES.map((r, i) => [r.slug, i]));
  return roles.sort((a, b) => (order.get(a.slug) ?? 99) - (order.get(b.slug) ?? 99) || a.name.localeCompare(b.name));
}

/**
 * Reads every role and seeds any built-in whose slug is missing. Two
 * processes seeding at once could each create a row for the same slug;
 * the oldest row wins when that happens and the other is ignored.
 */
async function loadRoles(): Promise<RoleDef[]> {
  await ensureCollections();
  const docs = await docQuery(ROLES, null, 1000);
  const bySlug = new Map<string, { role: RoleDef; createdAt: number }>();
  for (const d of docs) {
    const role = toRole(d);
    if (!role) continue;
    const createdAt = num(d.body.created_at, d.created_at);
    const seen = bySlug.get(role.slug);
    if (!seen || createdAt < seen.createdAt) bySlug.set(role.slug, { role, createdAt });
  }
  const now = Date.now();
  for (const b of BUILTIN_ROLES) {
    if (bySlug.has(b.slug)) continue;
    const role: RoleDef = { id: randomUUID(), ...b };
    await docPut(ROLES, role.id, roleBody(role, "seed", now), { ifNotExists: true });
    bySlug.set(role.slug, { role, createdAt: now });
  }
  return sortRoles([...bySlug.values()].map((v) => v.role));
}

/** Every role, built-ins first in their canonical order, then the rest by name. Cached a minute. */
export async function listRoles(): Promise<RoleDef[]> {
  if (rolesCache && rolesCache.expiresAt > Date.now()) return rolesCache.roles;
  rolesLoading ??= loadRoles()
    .then((roles) => {
      rolesCache = { roles, expiresAt: Date.now() + CACHE_TTL };
      return roles;
    })
    .finally(() => {
      rolesLoading = null;
    });
  return rolesLoading;
}

/** The role with this UUID, or null. */
export async function getRole(id: string): Promise<RoleDef | null> {
  if (!isRoleId(id)) return null;
  return (await listRoles()).find((r) => r.id === id) ?? null;
}

export async function getRoleBySlug(slug: RoleSlug): Promise<RoleDef | null> {
  if (!isRoleSlug(slug)) return null;
  return (await listRoles()).find((r) => r.slug === slug) ?? null;
}

/** Name and description for a role slug, falling back to the built-in definition or the slug itself when the row is gone or unreadable. */
export async function describeRole(slug: RoleSlug): Promise<RoleDef> {
  try {
    const role = await getRoleBySlug(slug);
    if (role) return role;
  } catch (err) {
    console.error(`[account] could not read role ${slug}: ${(err as Error).message}`);
  }
  const builtin = BUILTIN_ROLES.find((r) => r.slug === slug);
  return builtin ? { id: "", ...builtin } : { id: "", slug, name: slug, description: "", builtin: false };
}

export type RoleCreate = { outcome: "created" | "exists" | "invalid"; role?: RoleDef; reason?: string };

/** Adds a role with a fresh UUID; its slug comes from the name and must be new. */
export async function createRole(input: { name: string; description: string }, byUserId: string): Promise<RoleCreate> {
  const name = input.name.trim().replace(/\s+/g, " ");
  const description = input.description.trim();
  if (name.length < 2 || name.length > 40) return { outcome: "invalid", reason: "Give the role a name of 2 to 40 characters." };
  if (description.length > 200) return { outcome: "invalid", reason: "Keep the description under 200 characters." };
  const slug = roleSlugFromName(name);
  if (!slug) return { outcome: "invalid", reason: "The name needs at least one letter." };
  rolesCache = null;
  const existing = await getRoleBySlug(slug);
  if (existing) return { outcome: "exists", role: existing };
  const role: RoleDef = { id: randomUUID(), slug, name, description, builtin: false };
  await docPut(ROLES, role.id, roleBody(role, byUserId, Date.now()), { ifNotExists: true });
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

/** The role slug that counts: the ACCOUNT_ADMINS list wins, then the assigned role, then member. */
export function effectiveRole(assigned: RoleSlug | null, email: string): RoleSlug {
  if (isConfiguredAdmin(email)) return ADMIN_ROLE;
  return assigned ?? DEFAULT_ROLE;
}

function toRecord(doc: AnvilDocument): AccountRecord {
  const b = doc.body;
  return {
    userId: str(b.user_id, doc.key),
    roleId: str(b.role_id),
    setBy: str(b.set_by),
    setAt: num(b.set_at),
    createdAt: num(b.created_at),
    updatedAt: num(b.updated_at),
  };
}

export async function getAccountRecord(userId: string): Promise<AccountRecord | null> {
  if (!USER_ID.test(userId)) return null;
  await ensureCollections();
  const doc = await docGet(ACCOUNTS, userId);
  return doc ? toRecord(doc) : null;
}

/** The slug of the role a record points at, or null when it points nowhere (no record, or the role row is gone). */
function assignedSlug(record: AccountRecord | null, roles: RoleDef[]): RoleSlug | null {
  if (!record) return null;
  return roles.find((r) => r.id === record.roleId)?.slug ?? null;
}

/**
 * The slug of the role assigned now (cached a minute), under the
 * ACCOUNT_ADMINS override. A role whose row has been removed counts as
 * member. Guards use this so a change made by an admin applies within a
 * minute, not at the person's next sign-in. Throws when Anvil cannot be read.
 */
export async function getAccountRole(userId: string, email: string): Promise<RoleSlug> {
  if (isConfiguredAdmin(email)) return ADMIN_ROLE;
  const cached = roleOfUser.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.role;
  const [record, roles] = await Promise.all([getAccountRecord(userId), listRoles()]);
  const role = effectiveRole(assignedSlug(record, roles), email);
  rememberRole(userId, role);
  return role;
}

/**
 * The role slug for a fresh session cookie. Never throws: when Anvil cannot
 * be read the person signs in with the role the environment alone can vouch
 * for, and the error is logged.
 */
export async function roleForSignIn(identity: { sub: string; email: string }): Promise<RoleSlug> {
  try {
    return await getAccountRole(identity.sub, identity.email);
  } catch (err) {
    console.error(`[account] could not read the role of ${identity.sub} at sign-in: ${(err as Error).message}`);
    return effectiveRole(null, identity.email);
  }
}

/** Points a user at the role with UUID `roleId`, creating or replacing their accounts row. The role must exist. */
export async function setAccountRole(userId: string, roleId: string, byUserId: string): Promise<AccountRecord> {
  if (!USER_ID.test(userId)) throw new AnvilError("Invalid user id", 400);
  if (!(await getRole(roleId))) throw new AnvilError(`No role with id ${JSON.stringify(roleId)}`, 400);
  const existing = await getAccountRecord(userId);
  const now = Date.now();
  const next: AccountRecord = { userId, roleId, setBy: byUserId, setAt: now, createdAt: existing?.createdAt || now, updatedAt: now };
  await docPut(ACCOUNTS, userId, { user_id: userId, role_id: roleId, set_by: byUserId, set_at: now, created_at: next.createdAt, updated_at: now });
  roleOfUser.delete(userId);
  return next;
}

export type RoleChange = { outcome: "updated" | "unchanged" | "no_account"; record?: AccountRecord };

/** Points whoever owns `email` in Anvil at the role with UUID `roleId`; `no_account` when nobody does. */
export async function assignRoleByEmail(email: string, roleId: string, byUserId: string): Promise<RoleChange> {
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
  /** Slug of the role they effectively hold. */
  role: RoleSlug;
  /** UUID of that role's row ("" only if the row is missing, which the seed prevents for built-ins). */
  roleId: string;
  /** Unix ms from auth.users, 0 when unknown. */
  lastSignedInAt: number;
  /** Explicitly assigned (an accounts row points at an existing role) rather than the default. */
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
  await ensureCollections();
  const [memberIds, rows, roles] = await Promise.all([listAccountAppMemberIds(), docQuery(ACCOUNTS, null, 10_000), listRoles()]);
  const records = new Map(rows.map(toRecord).map((r) => [r.userId, r]));
  const ids = [...new Set([...memberIds, ...records.keys()])];
  const users = await usersById(ids);
  const idOf = new Map(roles.map((r) => [r.slug, r.id]));
  return ids
    .map((id): Person => {
      const u = users.get(id);
      const assigned = assignedSlug(records.get(id) ?? null, roles);
      const email = u?.email ?? "";
      const role = effectiveRole(assigned, email);
      return {
        id,
        email,
        username: u?.username ?? "",
        role,
        roleId: idOf.get(role) ?? "",
        lastSignedInAt: u?.lastSignedInAt ?? 0,
        assigned: assigned !== null,
        pinned: isConfiguredAdmin(email),
      };
    })
    .sort((a, b) => b.lastSignedInAt - a.lastSignedInAt || a.email.localeCompare(b.email));
}
