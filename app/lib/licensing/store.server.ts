/**
 * Who owns which Hammer key, in Anvil's document store under the Devforge
 * account app (schema app_devforge, the same app the site account lives in).
 *
 *   licenses   key = hallmark licence id   {id, key, product, userId, email, licensee,
 *                                          seats, subscriptionId, customerId, status,
 *                                          issuedAt, revokedAt?, revokedReason?, updatedAt}
 *   locks      key = lock name             {at}   short-lived, see acquireLock
 *
 * Hallmark stays authoritative for the key itself (signature, seats, revoked);
 * these records exist so the account page can list a person's keys and the
 * webhook can tell what a subscription has already been given.
 */

import { AnvilError, docEnsureCollection, docGet, docPut, docQuery, serviceFetch, type AnvilDocument } from "../feature-requests/anvil.server";
import type { OwnedLicenseStatus } from "./shared";

const APP_SCHEMA = "app_devforge";
const LICENSES = `${APP_SCHEMA}.licenses`;
const LOCKS = `${APP_SCHEMA}.locks`;

let collectionsReady: Promise<void> | null = null;

function ensureCollections(): Promise<void> {
  collectionsReady ??= Promise.all([docEnsureCollection(LICENSES), docEnsureCollection(LOCKS)])
    .then(() => undefined)
    .catch((err) => {
      collectionsReady = null;
      throw err;
    });
  return collectionsReady;
}

/** For tests. */
export function resetLicenseStoreCache(): void {
  collectionsReady = null;
}

export type OwnedLicense = {
  /** Hallmark licence id (`lic_...`). */
  id: string;
  /** The signed key the customer pastes into Hammer. */
  key: string;
  product: string;
  /** Devforge account (Anvil user) id. */
  userId: string;
  email: string;
  licensee: string;
  seats: number;
  subscriptionId: string;
  customerId: string;
  status: OwnedLicenseStatus;
  /** Unix ms. */
  issuedAt: number;
  revokedAt?: number;
  revokedReason?: string;
  updatedAt: number;
};

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

function toLicense(doc: AnvilDocument): OwnedLicense {
  const b = doc.body;
  const out: OwnedLicense = {
    id: str(b.id, doc.key),
    key: str(b.key),
    product: str(b.product, "hammer"),
    userId: str(b.userId),
    email: str(b.email),
    licensee: str(b.licensee),
    seats: num(b.seats, 1),
    subscriptionId: str(b.subscriptionId),
    customerId: str(b.customerId),
    status: b.status === "revoked" ? "revoked" : "active",
    issuedAt: num(b.issuedAt),
    updatedAt: num(b.updatedAt),
  };
  if (typeof b.revokedAt === "number") out.revokedAt = b.revokedAt;
  if (typeof b.revokedReason === "string") out.revokedReason = b.revokedReason;
  return out;
}

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SUB_ID = /^[A-Za-z0-9_]{1,255}$/;

export async function listUserLicenses(userId: string): Promise<OwnedLicense[]> {
  if (!USER_ID.test(userId)) throw new AnvilError("Invalid user id", 400);
  await ensureCollections();
  const docs = await docQuery(LICENSES, { op: "eq", field: "userId", value: userId }, 1000);
  return docs.map(toLicense).sort((a, b) => b.issuedAt - a.issuedAt);
}

export async function listSubscriptionLicenses(subscriptionId: string): Promise<OwnedLicense[]> {
  if (!SUB_ID.test(subscriptionId)) throw new AnvilError("Invalid subscription id", 400);
  await ensureCollections();
  const docs = await docQuery(LICENSES, { op: "eq", field: "subscriptionId", value: subscriptionId }, 1000);
  return docs.map(toLicense).sort((a, b) => a.issuedAt - b.issuedAt);
}

/** A licence, only when `userId` owns it. */
export async function getOwnedLicense(id: string, userId: string): Promise<OwnedLicense | null> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  await ensureCollections();
  const doc = await docGet(LICENSES, id);
  if (!doc) return null;
  const lic = toLicense(doc);
  return lic.userId === userId ? lic : null;
}

export async function saveLicense(lic: OwnedLicense): Promise<void> {
  await ensureCollections();
  const body: Record<string, unknown> = { ...lic, updatedAt: Date.now() };
  await docPut(LICENSES, lic.id, body);
}

export async function markLicenseRevoked(id: string, reason: string): Promise<OwnedLicense | null> {
  await ensureCollections();
  const doc = await docGet(LICENSES, id);
  if (!doc) return null;
  const lic = toLicense(doc);
  const now = Date.now();
  const next: OwnedLicense = { ...lic, status: "revoked", revokedAt: lic.revokedAt ?? now, revokedReason: reason, updatedAt: now };
  await docPut(LICENSES, id, { ...next });
  return next;
}

/* ---------------------------------------------------------------------- */
/* Locks                                                                   */
/* ---------------------------------------------------------------------- */

const LOCK_NAME = /^[A-Za-z0-9_:.-]{1,128}$/;

function lockPath(name: string): string {
  if (!LOCK_NAME.test(name)) throw new AnvilError("Invalid lock name", 400);
  return `/docs/${LOCKS}/${encodeURIComponent(name)}`;
}

/**
 * A short lease on `name`, so two webhook deliveries for one subscription do
 * not both issue keys. Taken with a conditional create (`if_not_exists`) plus
 * Anvil's document TTL; a lease older than `ttlMs` is treated as abandoned and
 * replaced, in case the TTL sweep lags. Returns false when someone else holds it.
 */
export async function acquireLock(name: string, ttlMs = 90_000): Promise<boolean> {
  await ensureCollections();
  const path = lockPath(name);
  const take = () => serviceFetch(path, { method: "PUT", body: { body: { at: Date.now() }, if_not_exists: true, ttl_ms: ttlMs } });
  try {
    await take();
    return true;
  } catch (err) {
    if (!(err instanceof AnvilError) || err.status !== 409) throw err;
  }
  const held = await docGet(LOCKS, name);
  const at = held && typeof held.body.at === "number" ? held.body.at : 0;
  if (held && Date.now() - at <= ttlMs) return false;
  // Abandoned (or already swept): clear it and try once more.
  try {
    await serviceFetch(path, { method: "DELETE" });
    await take();
    return true;
  } catch (err) {
    if (err instanceof AnvilError && err.status === 409) return false;
    throw err;
  }
}

export async function releaseLock(name: string): Promise<void> {
  try {
    await serviceFetch(lockPath(name), { method: "DELETE" });
  } catch (err) {
    if (err instanceof AnvilError && err.status === 404) return;
    console.error("[licensing] could not release lock", name, (err as Error).message);
  }
}
