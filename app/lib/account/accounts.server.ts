/**
 * Devforge account records and roles, in Anvil's document store under the
 * account app's schema (app_devforge, next to the licence records).
 *
 *   accounts   key = Anvil user id (JWT sub)   {id, email, username, role, roleSetAt?,
 *                                               roleSetBy?, createdAt, lastSignInAt, updatedAt}
 *
 * Anvil authenticates the person; this record is what devforge.io knows about
 * them: which of the site's roles they hold (roles.ts) and when they were
 * last here. A record appears on the first sign-in after this module went
 * live, or when an admin assigns a role to an email that already has an Anvil
 * account. Addresses listed in `ACCOUNT_ADMINS` are admins whatever the record
 * says, which is how the first admin gets in.
 */

import { AnvilError, docEnsureCollection, docGet, docPut, docQuery, lookupUserIdByEmail, type AnvilDocument } from "../feature-requests/anvil.server";
import { DEFAULT_ROLE, isAccountRole, type AccountRole } from "./roles";

const ACCOUNTS = "app_devforge.accounts";

export type AccountRecord = {
  /** Anvil user id (the JWT `sub`). */
  id: string;
  /** Lower-cased. */
  email: string;
  username: string;
  role: AccountRole;
  /** Unix ms of the last explicit role change, and who made it. */
  roleSetAt?: number;
  roleSetBy?: string;
  /** Unix ms. */
  createdAt: number;
  /** Unix ms; 0 for a record created by an admin before the person's first sign-in. */
  lastSignInAt: number;
  updatedAt: number;
};

let collectionReady: Promise<void> | null = null;

function ensureCollection(): Promise<void> {
  collectionReady ??= docEnsureCollection(ACCOUNTS).catch((err) => {
    collectionReady = null;
    throw err;
  });
  return collectionReady;
}

const ROLE_TTL = 60_000;
const roleCache = new Map<string, { role: AccountRole; expiresAt: number }>();

function remember(userId: string, role: AccountRole) {
  if (roleCache.size > 10_000) roleCache.clear();
  roleCache.set(userId, { role, expiresAt: Date.now() + ROLE_TTL });
}

/** For tests. */
export function resetAccountsCache(): void {
  collectionReady = null;
  roleCache.clear();
}

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

/** The role that counts: the ACCOUNT_ADMINS list wins, then the stored role, then member. */
export function effectiveRole(record: Pick<AccountRecord, "role" | "email"> | null, email = ""): AccountRole {
  if (isConfiguredAdmin(email) || (record && isConfiguredAdmin(record.email))) return "admin";
  return record?.role ?? DEFAULT_ROLE;
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

function toRecord(doc: AnvilDocument): AccountRecord {
  const b = doc.body;
  const out: AccountRecord = {
    id: str(b.id, doc.key),
    email: str(b.email).toLowerCase(),
    username: str(b.username),
    role: isAccountRole(b.role) ? b.role : DEFAULT_ROLE,
    createdAt: num(b.createdAt),
    lastSignInAt: num(b.lastSignInAt),
    updatedAt: num(b.updatedAt),
  };
  if (typeof b.roleSetAt === "number") out.roleSetAt = b.roleSetAt;
  if (typeof b.roleSetBy === "string") out.roleSetBy = b.roleSetBy;
  return out;
}

export async function getAccountRecord(userId: string): Promise<AccountRecord | null> {
  if (!USER_ID.test(userId)) return null;
  await ensureCollection();
  const doc = await docGet(ACCOUNTS, userId);
  return doc ? toRecord(doc) : null;
}

/**
 * Called on every successful sign-in: creates the record for a first-timer
 * (role member, or admin when the address is in ACCOUNT_ADMINS) and refreshes
 * email, username and lastSignInAt otherwise. Returns the effective role for
 * the session cookie. Never throws: Anvil trouble is logged and the person
 * signs in with the role the environment alone can vouch for.
 */
export async function recordSignIn(identity: { sub: string; email: string; username: string }): Promise<AccountRole> {
  const email = identity.email.trim().toLowerCase();
  try {
    const existing = await getAccountRecord(identity.sub);
    const now = Date.now();
    const record: AccountRecord = existing
      ? { ...existing, email: email || existing.email, username: identity.username || existing.username, lastSignInAt: now, updatedAt: now }
      : {
          id: identity.sub,
          email,
          username: identity.username,
          role: isConfiguredAdmin(email) ? "admin" : DEFAULT_ROLE,
          createdAt: now,
          lastSignInAt: now,
          updatedAt: now,
        };
    await docPut(ACCOUNTS, identity.sub, { ...record });
    const role = effectiveRole(record);
    remember(identity.sub, role);
    return role;
  } catch (err) {
    console.error(`[account] could not record sign-in for ${identity.sub}: ${(err as Error).message}`);
    return effectiveRole(null, email);
  }
}

/**
 * The role as stored now (cached for a minute), under the ACCOUNT_ADMINS
 * override. Guards use this so a change made by an admin applies within a
 * minute, not at the person's next sign-in. Throws when Anvil cannot be read.
 */
export async function getAccountRole(userId: string, email: string): Promise<AccountRole> {
  if (isConfiguredAdmin(email)) return "admin";
  const cached = roleCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.role;
  const record = await getAccountRecord(userId);
  const role = effectiveRole(record, email);
  remember(userId, role);
  return role;
}

/** Every account record, most recent sign-in first. */
export async function listAccounts(): Promise<AccountRecord[]> {
  await ensureCollection();
  const docs = await docQuery(ACCOUNTS, null, 5000);
  return docs.map(toRecord).sort((a, b) => b.lastSignInAt - a.lastSignInAt || a.email.localeCompare(b.email));
}

/** Sets the stored role on an existing record; null when the person has none yet. */
export async function setAccountRole(userId: string, role: AccountRole, byUserId: string): Promise<AccountRecord | null> {
  if (!USER_ID.test(userId)) throw new AnvilError("Invalid user id", 400);
  const existing = await getAccountRecord(userId);
  if (!existing) return null;
  const now = Date.now();
  const next: AccountRecord = { ...existing, role, roleSetAt: now, roleSetBy: byUserId, updatedAt: now };
  await docPut(ACCOUNTS, userId, { ...next });
  roleCache.delete(userId);
  return next;
}

export type RoleChange = { outcome: "updated" | "created" | "unchanged" | "no_account"; record?: AccountRecord };

/**
 * Assigns a role by email: updates the record when the person has one,
 * otherwise looks the Anvil account up and creates the record, so a role can
 * be set before someone's first sign-in here. `no_account` when Anvil has no
 * user with that address.
 */
export async function assignRoleByEmail(email: string, role: AccountRole, byUserId: string): Promise<RoleChange> {
  const needle = email.trim().toLowerCase();
  if (!needle) return { outcome: "no_account" };
  await ensureCollection();
  const docs = await docQuery(ACCOUNTS, { op: "eq", field: "email", value: needle }, 5);
  let existing: AccountRecord | null = docs.length > 0 ? toRecord(docs[0]) : null;
  let userId = existing?.id ?? "";
  if (!existing) {
    userId = await lookupUserIdByEmail(needle);
    if (!userId) return { outcome: "no_account" };
    // The record may exist under an older spelling of the address.
    existing = await getAccountRecord(userId);
  }
  if (existing) {
    if (existing.role === role) return { outcome: "unchanged", record: existing };
    const updated = await setAccountRole(existing.id, role, byUserId);
    return updated ? { outcome: "updated", record: updated } : { outcome: "no_account" };
  }
  const now = Date.now();
  const record: AccountRecord = { id: userId, email: needle, username: "", role, roleSetAt: now, roleSetBy: byUserId, createdAt: now, lastSignInAt: 0, updatedAt: now };
  await docPut(ACCOUNTS, userId, { ...record });
  roleCache.delete(userId);
  return { outcome: "created", record };
}
