/**
 * Client for hallmark, the Devforge licence service (devforge-io/hallmark,
 * running at licensing.devforge.io:8443). This app only uses the admin API,
 * behind `Authorization: Bearer <HALLMARK_ADMIN_TOKEN>`: issue, inspect and
 * revoke licences and drop a machine's activation. Hallmark is the source of
 * truth for a key, its seats and its revocation; this app keeps its own record
 * of who bought what (store.server.ts) because hallmark has no notion of a
 * customer and cannot list licences by email.
 *
 * Keys are Ed25519-signed tokens `HMR-<base64url json>.<base64url signature>`.
 * `verifyLicenseKey` checks one offline against HALLMARK_PUBLIC_KEY, the same
 * key Hammer embeds, so a key shown to a customer can be sanity-checked here.
 */

import { createPublicKey, verify as verifySignature } from "node:crypto";

export const DEFAULT_HALLMARK_URL = "https://licensing.devforge.io:8443";

export class HallmarkError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "HallmarkError";
    this.status = status;
  }
}

export function hallmarkConfig(): { url: string; adminToken: string; publicKey: string } {
  return {
    url: (process.env.HALLMARK_URL || DEFAULT_HALLMARK_URL).replace(/\/+$/, ""),
    adminToken: (process.env.HALLMARK_ADMIN_TOKEN || "").trim(),
    publicKey: (process.env.HALLMARK_PUBLIC_KEY || "").trim(),
  };
}

/** True when this app can issue licences. */
export function hallmarkConfigured(): boolean {
  return Boolean(hallmarkConfig().adminToken);
}

/** The signed part of a key, as hallmark's `LicensePayload`. */
export type LicensePayload = {
  v: number;
  id: string;
  product: string;
  licensee: string;
  email: string;
  /** Unix seconds. */
  issued: number;
  /** Unix seconds; absent never expires. */
  expires?: number;
  /** Absent means unlimited. */
  seats?: number;
};

/** A stored licence (hallmark's `LicenseRecord`, payload flattened). */
export type LicenseRecord = LicensePayload & {
  key: string;
  revoked: boolean;
  revoked_at?: number;
  note?: string;
};

export type Activation = { first_seen: number; last_seen: number; app_version?: string };

export type LicenseDetails = {
  license: LicenseRecord;
  seats_used: number;
  /** Keyed by machine id. */
  activations: Record<string, Activation>;
};

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function licenseIdPath(id: string): string {
  if (!ID.test(id)) throw new HallmarkError("Invalid licence id", 400);
  return `/v1/admin/licenses/${id}`;
}

async function adminFetch<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const { url, adminToken } = hallmarkConfig();
  if (!adminToken) throw new HallmarkError("Licensing is not configured (set HALLMARK_ADMIN_TOKEN)", 503);
  const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${adminToken}` };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(url + path, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new HallmarkError(`The licence service is unreachable (${(err as Error).message})`, 503);
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 200) };
    }
  }
  if (!res.ok) {
    const error = data && typeof data === "object" ? (data as { error?: unknown }).error : undefined;
    throw new HallmarkError(typeof error === "string" && error ? error : `The licence service returned ${res.status}`, res.status);
  }
  return data as T;
}

export type IssueInput = {
  /** Defaults to hammer on the server. */
  product?: string;
  licensee: string;
  email?: string;
  /** `YYYY-MM-DD` or Unix seconds; omit for a key that never expires. */
  expires?: string;
  /** Omit for unlimited. */
  seats?: number;
  note?: string;
};

/** POST /v1/admin/licenses: mint a key. The response carries the key exactly once; store it. */
export async function issueLicense(input: IssueInput): Promise<LicenseRecord> {
  const body: Record<string, unknown> = { licensee: input.licensee };
  if (input.product) body.product = input.product;
  if (input.email) body.email = input.email;
  if (input.expires) body.expires = input.expires;
  if (input.seats !== undefined) body.seats = input.seats;
  if (input.note) body.note = input.note;
  const res = await adminFetch<LicenseRecord>("/v1/admin/licenses", { body });
  if (!res || typeof res.id !== "string" || typeof res.key !== "string") {
    throw new HallmarkError("The licence service did not return a key", 502);
  }
  return res;
}

/** GET /v1/admin/licenses[?product=]: every licence on file with its seats in use. */
export async function listLicenses(product?: string): Promise<(LicenseRecord & { seats_used: number })[]> {
  const q = product ? `?product=${encodeURIComponent(product)}` : "";
  const res = await adminFetch<unknown>(`/v1/admin/licenses${q}`);
  return Array.isArray(res) ? (res as (LicenseRecord & { seats_used: number })[]) : [];
}

/** GET /v1/admin/licenses/{id}: the record, seats in use and activations; null when unknown. */
export async function showLicense(id: string): Promise<LicenseDetails | null> {
  try {
    const res = await adminFetch<LicenseDetails>(licenseIdPath(id));
    return { license: res.license, seats_used: res.seats_used ?? 0, activations: res.activations ?? {} };
  } catch (err) {
    if (err instanceof HallmarkError && err.status === 404) return null;
    throw err;
  }
}

/** POST /v1/admin/licenses/{id}/revoke. Revoking is permanent; hallmark has no undo. */
export async function revokeLicense(id: string): Promise<LicenseRecord> {
  return adminFetch<LicenseRecord>(`${licenseIdPath(id)}/revoke`, { method: "POST" });
}

/** DELETE /v1/admin/licenses/{id}/activations/{machine}: free a seat. */
export async function dropActivation(id: string, machine: string): Promise<{ removed: boolean; seats_used: number }> {
  const m = machine.trim();
  if (!m || m.length > 128 || !/^[\x21-\x7e]+$/.test(m)) throw new HallmarkError("Invalid machine id", 400);
  return adminFetch(`${licenseIdPath(id)}/activations/${encodeURIComponent(m)}`, { method: "DELETE" });
}

export async function hallmarkHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${hallmarkConfig().url}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { status?: unknown };
    return body.status === "ok";
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------------- */
/* Offline verification                                                    */
/* ---------------------------------------------------------------------- */

const LICENSE_PREFIX = "HMR-";
/** DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Verifies a key's signature against the service's public key and returns its
 * payload. Throws a HallmarkError(400) for anything that does not check out.
 */
export function verifyLicenseKey(key: string, publicKeyB64: string = hallmarkConfig().publicKey): LicensePayload {
  if (!publicKeyB64) throw new HallmarkError("HALLMARK_PUBLIC_KEY is not set", 503);
  const raw = b64urlDecode(publicKeyB64);
  if (raw.length !== 32) throw new HallmarkError("HALLMARK_PUBLIC_KEY is not a 32-byte Ed25519 key", 503);
  const token = key.trim();
  if (!token.startsWith(LICENSE_PREFIX)) throw new HallmarkError("Not a Hammer licence key", 400);
  const dot = token.indexOf(".", LICENSE_PREFIX.length);
  if (dot === -1) throw new HallmarkError("The key has no signature", 400);
  const payloadBytes = b64urlDecode(token.slice(LICENSE_PREFIX.length, dot));
  const signature = b64urlDecode(token.slice(dot + 1));
  if (signature.length !== 64) throw new HallmarkError("The key's signature has the wrong length", 400);
  const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
  if (!verifySignature(null, payloadBytes, publicKey, signature)) throw new HallmarkError("The key's signature does not match", 400);
  let payload: LicensePayload;
  try {
    payload = JSON.parse(payloadBytes.toString("utf8")) as LicensePayload;
  } catch {
    throw new HallmarkError("The key's payload is malformed", 400);
  }
  if (typeof payload.id !== "string" || typeof payload.product !== "string") throw new HallmarkError("The key's payload is malformed", 400);
  return payload;
}
