/**
 * Minimal Anvil DB client for the feature-requests tool.
 *
 * Talks to Anvil's HTTP API (POST /db/query plus the /auth endpoints). The app
 * authenticates to Anvil as a service principal (an API key, or the admin
 * user), and end users authenticate through Anvil's own auth endpoints: their
 * accounts live in Anvil's auth.users, Anvil issues the tokens, and this app
 * keeps its own signed session cookie once a login succeeds.
 *
 * Query parameters are deliberately NOT used: on the Anvil build this was
 * written against (v0.1.0) they bind only inside MATCH map patterns, not in
 * CREATE maps, SET or WHERE. Values are inlined through `lit()` instead, which
 * produces a strictly escaped Cypher literal, and ids go through `ident()`.
 */

import { randomBytes } from "node:crypto";

export type AnvilConfig = {
  url: string;
  database: string;
  serviceKey: string;
  adminUser: string;
  adminPassword: string;
};

export function getAnvilConfig(): AnvilConfig {
  return {
    // No default on purpose: the tool only talks to the Anvil you configure.
    url: (process.env.ANVIL_URL || "").replace(/\/+$/, ""),
    // Only sent when set: on Anvil 0.1.0 naming the database switches the
    // schema context as well, which makes ordinary labels "reserved by public".
    database: process.env.ANVIL_DATABASE || "",
    serviceKey: process.env.ANVIL_SERVICE_KEY || "",
    adminUser: process.env.ANVIL_ADMIN_USER || "admin",
    adminPassword: process.env.ANVIL_ADMIN_PASSWORD || "",
  };
}

/** True when the tool has enough configuration to reach Anvil. */
export function anvilConfigured(): boolean {
  const c = getAnvilConfig();
  return Boolean(c.url && (c.serviceKey || c.adminPassword));
}

export class AnvilError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "AnvilError";
    this.status = status;
  }
}

type Json = Record<string, unknown>;

async function anvilFetch<T = Json>(
  path: string,
  init: { method?: string; body?: unknown; token?: string | null; headers?: Record<string, string> } = {},
): Promise<T> {
  const { url } = getAnvilConfig();
  if (!url) throw new AnvilError("Anvil is not configured (set ANVIL_URL)", 503);
  const headers: Record<string, string> = { accept: "application/json", ...(init.headers ?? {}) };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  let res: Response;
  try {
    res = await fetch(url + path, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new AnvilError(`Anvil is unreachable (${(err as Error).message})`, 503);
  }
  const text = await res.text();
  let data: Json = {};
  if (text) {
    try {
      data = JSON.parse(text) as Json;
    } catch {
      data = { error: text.slice(0, 200) };
    }
  }
  if (!res.ok) {
    const message =
      (typeof data.message === "string" && data.message) ||
      (typeof data.error === "string" && data.error) ||
      `Anvil returned ${res.status}`;
    throw new AnvilError(message, res.status);
  }
  return data as T;
}

/* ---------------------------------------------------------------------- */
/* Service principal                                                       */
/* ---------------------------------------------------------------------- */

let cachedAdmin: { token: string; expiresAt: number } | null = null;

/** Token the app itself uses against Anvil: the API key, or a cached admin login. */
async function serviceToken(force = false): Promise<string> {
  const c = getAnvilConfig();
  if (c.serviceKey) return c.serviceKey;
  if (!force && cachedAdmin && cachedAdmin.expiresAt > Date.now()) return cachedAdmin.token;
  if (!c.adminPassword) throw new AnvilError("Anvil is not configured (set ANVIL_SERVICE_KEY or ANVIL_ADMIN_PASSWORD)", 503);
  const login = await anvilLogin(c.adminUser, c.adminPassword);
  cachedAdmin = { token: login.accessToken, expiresAt: Date.now() + 50 * 60 * 1000 };
  return login.accessToken;
}

export type CypherResult = { columns: string[]; rows: unknown[][]; rowCount?: number };

/** Runs a Cypher statement as the service principal. Retries once on a stale admin token. */
export async function cypher(query: string): Promise<CypherResult> {
  const { database } = getAnvilConfig();
  const body: Record<string, unknown> = database ? { query, database } : { query };
  const run = (token: string) => anvilFetch<CypherResult>("/db/query", { body, token });
  try {
    return await run(await serviceToken());
  } catch (err) {
    if (err instanceof AnvilError && err.status === 401 && !getAnvilConfig().serviceKey) {
      return run(await serviceToken(true));
    }
    throw err;
  }
}

/* ---------------------------------------------------------------------- */
/* Document store                                                          */
/* ---------------------------------------------------------------------- */

export type AnvilDocument = {
  key: string;
  body: Record<string, unknown>;
  created_at: number;
  updated_at: number;
  version: number;
};

export type DocFilter =
  | { op: "eq" | "neq" | "lt" | "gt" | "contains"; field: string; value: unknown }
  | { op: "begins_with"; field: string; prefix: string }
  | { op: "between"; field: string; low: unknown; high: unknown }
  | { op: "in"; field: string; values: unknown[] }
  | { op: "exists"; field: string }
  | { op: "and" | "or"; conditions: DocFilter[] };

/** Runs a document-store call as the service principal, retrying a stale admin token once. */
async function serviceFetch<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  try {
    return await anvilFetch<T>(path, { ...init, token: await serviceToken() });
  } catch (err) {
    if (err instanceof AnvilError && err.status === 401 && !getAnvilConfig().serviceKey) {
      return anvilFetch<T>(path, { ...init, token: await serviceToken(true) });
    }
    throw err;
  }
}

/** Reserve a fresh server-minted UUID (POST /db/uuid, locked for 5 minutes). */
export async function reserveUuid(): Promise<string> {
  const res = await serviceFetch<{ uuid?: unknown }>("/db/uuid", { method: "POST" });
  if (typeof res.uuid !== "string" || res.uuid.length === 0) {
    throw new AnvilError("Anvil did not return a uuid", 502);
  }
  return res.uuid;
}

const COLLECTION_NAME = /^[a-z][a-z0-9_.]{0,63}$/;

function collectionPath(collection: string, key?: string): string {
  if (!COLLECTION_NAME.test(collection)) throw new AnvilError(`Invalid collection name ${collection}`, 500);
  return `/docs/${collection}` + (key !== undefined ? `/${encodeURIComponent(key)}` : "");
}

/** Creates a collection if it does not exist yet; safe to call repeatedly. */
export async function docEnsureCollection(collection: string): Promise<void> {
  try {
    await serviceFetch(collectionPath(collection), { method: "POST", body: { composite_keys: false } });
  } catch (err) {
    if (err instanceof AnvilError && (err.status === 409 || /exist/i.test(err.message))) return;
    throw err;
  }
}

export async function docPut(
  collection: string,
  key: string,
  body: Record<string, unknown>,
  opts: { ifNotExists?: boolean } = {},
): Promise<AnvilDocument> {
  return serviceFetch<AnvilDocument>(collectionPath(collection, key), {
    method: "PUT",
    body: { body, if_not_exists: opts.ifNotExists ?? false },
  });
}

export async function docGet(collection: string, key: string): Promise<AnvilDocument | null> {
  try {
    return await serviceFetch<AnvilDocument>(collectionPath(collection, key));
  } catch (err) {
    if (err instanceof AnvilError && err.status === 404) return null;
    throw err;
  }
}

export async function docDelete(collection: string, key: string): Promise<void> {
  try {
    await serviceFetch(collectionPath(collection, key), { method: "DELETE" });
  } catch (err) {
    if (err instanceof AnvilError && err.status === 404) return;
    throw err;
  }
}

export async function docQuery(collection: string, filter: DocFilter | null, limit = 1000): Promise<AnvilDocument[]> {
  const res = await serviceFetch<{ documents: AnvilDocument[] }>(`${collectionPath(collection)}/query`, {
    method: "POST",
    body: { filter: filter ?? undefined, limit },
  });
  return Array.isArray(res.documents) ? res.documents : [];
}

/** Node values come back as `{_id, _labels, ...props}`; this strips the internals. */
export function nodeProps(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "_id" || k === "_labels") continue;
    out[k] = v;
  }
  return out;
}

/** Rows of a single-column `RETURN n` query as property objects. */
export function nodes(result: CypherResult): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const row of result.rows) {
    const props = nodeProps(row[0]);
    if (props) out.push(props);
  }
  return out;
}

/** First cell of the first row, or null. */
export function scalar(result: CypherResult): unknown {
  return result.rows.length ? result.rows[0][0] : null;
}

/* ---------------------------------------------------------------------- */
/* Literals and identifiers                                                */
/* ---------------------------------------------------------------------- */

/**
 * Cypher literal for a JS value. Strings are quoted with backslash, quote,
 * newline and tab escaped and other control characters removed; everything
 * that is not a finite number, boolean or string becomes null. Arrays and
 * objects are not supported on purpose (this Anvil build does not round-trip
 * list properties): store them as delimited strings.
 *
 * Anvil 0.1.0's lexer has a quirk: once it has seen an escaped quote of the
 * delimiting kind, a later `//` (or `/*`) inside the same literal is taken for
 * a comment and the literal is "unterminated". So the delimiter is chosen per
 * value (double quotes unless that combination occurs, then single quotes),
 * and in the rare value where both delimiters are followed by a comment
 * opener, a zero-width space is slipped between the two characters.
 */
export function lit(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value !== "string") return "null";
  let text = value;
  let delim = '"';
  if (triggersCommentBug(text, '"')) {
    if (!triggersCommentBug(text, "'")) delim = "'";
    else text = text.replace(/\/(?=[/*])/g, "/\u200b");
  }
  let out = delim;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\\") out += "\\\\";
    else if (ch === delim) out += "\\" + delim;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    // Anvil 0.1.0 does not decode \uXXXX escapes, and no control character
    // other than newline and tab has a place in this tool's text, so drop them.
    else if (code < 0x20 || code === 0x7f) continue;
    else out += ch;
  }
  return out + delim;
}

/** True when `text` contains `delim` followed later by a comment opener. */
function triggersCommentBug(text: string, delim: string): boolean {
  const i = text.indexOf(delim);
  if (i === -1) return false;
  const rest = text.slice(i + 1);
  return rest.includes("//") || rest.includes("/*");
}

const IDENT = /^[A-Za-z0-9_-]{1,64}$/;

/** Validates an id before it is inlined into a query; throws on anything odd. */
export function ident(value: unknown, what = "id"): string {
  if (typeof value !== "string" || !IDENT.test(value)) {
    throw new AnvilError(`Invalid ${what}`, 400);
  }
  return value;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Unbiased random id over [A-Za-z0-9]. */
export function newId(length = 14): string {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte < 248) out += ALPHABET[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

/** Builds a `{k: v, ...}` map literal from an object, skipping undefined values. */
export function mapLit(props: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new AnvilError(`Invalid property name ${k}`, 500);
    parts.push(`${k}: ${lit(v)}`);
  }
  return `{${parts.join(", ")}}`;
}

/** `SET n.a = .., n.b = ..` fragment for an update. */
export function setLit(alias: string, props: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new AnvilError(`Invalid property name ${k}`, 500);
    parts.push(`${alias}.${k} = ${lit(v)}`);
  }
  return parts.length ? `SET ${parts.join(", ")}` : "";
}

/* ---------------------------------------------------------------------- */
/* Auth (end users)                                                        */
/* ---------------------------------------------------------------------- */

/**
 * The Anvil app this tool belongs to (APPS.md). Passed on registration and
 * OTP requests so Anvil uses the app's email templates and settings overrides
 * when configured; harmless while none are set.
 */
export const APP_SLUG = "feature_requests";

export type AnvilTokens = { accessToken: string; idToken?: string; refreshToken?: string };
export type AnvilIdentity = { sub: string; username: string; email: string; roles: string[] };

export function decodeJwt(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2) return {};
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function identityFromToken(token: string): AnvilIdentity | null {
  const p = decodeJwt(token);
  const sub = typeof p.sub === "string" ? p.sub : "";
  if (!sub) return null;
  return {
    sub,
    username: typeof p.username === "string" ? p.username : "",
    email: typeof p.email === "string" ? p.email : "",
    roles: Array.isArray(p.roles) ? (p.roles as unknown[]).filter((r): r is string => typeof r === "string") : [],
  };
}

export async function anvilLogin(username: string, password: string): Promise<AnvilTokens> {
  return anvilFetch<AnvilTokens>("/auth/login", { body: { username, password } });
}

/**
 * Creates an Anvil user through the admin-only register endpoint. No username
 * is sent on purpose: Anvil assigns one server-side (email local part, hex
 * suffix only on collision) and rejects duplicate emails with a 409. Sign-in
 * uses the email; Anvil's login resolves it to the stored username.
 */
export async function anvilRegister(email: string, password: string): Promise<{ id: string }> {
  const token = await serviceToken();
  try {
    return await anvilFetch<{ id: string }>("/auth/register", { body: { email, password, app: APP_SLUG }, token });
  } catch (err) {
    if (err instanceof AnvilError && err.status === 401 && !getAnvilConfig().serviceKey) {
      return anvilFetch<{ id: string }>("/auth/register", {
        body: { email, password, app: APP_SLUG },
        token: await serviceToken(true),
      });
    }
    throw err;
  }
}

/**
 * Registers a board visitor by email, best-effort. Anvil assigns the username
 * and, when its email sending is configured, mails a verification token as
 * part of registration. The password is random and never shown: these
 * accounts sign in with an emailed code. An existing account (409) is fine;
 * any other failure is reported but must never sink the caller's write.
 */
export async function registerVisitor(
  email: string,
): Promise<{ account: "created" | "existing" | "failed"; verificationSent: boolean; userId: string }> {
  try {
    const res = await anvilRegister(email, newId(32));
    const sent = (res as { verification_sent?: unknown }).verification_sent === true;
    const userId = typeof (res as { id?: unknown }).id === "string" ? (res as { id: string }).id : "";
    return { account: "created", verificationSent: sent, userId };
  } catch (err) {
    if (err instanceof AnvilError && err.status === 409) {
      return { account: "existing", verificationSent: false, userId: await lookupUserIdByEmail(email) };
    }
    console.error("[feature-requests] visitor registration failed:", (err as Error).message);
    return { account: "failed", verificationSent: false, userId: "" };
  }
}

/** The Anvil user id for an email, or "" when no account matches. */
export async function lookupUserIdByEmail(email: string): Promise<string> {
  try {
    const needle = email.trim().toLowerCase();
    const docs = await docQuery("auth.users", null, 100_000);
    for (const d of docs) {
      const e = d.body.email;
      if (typeof e === "string" && e.toLowerCase() === needle) {
        return typeof d.body.id === "string" ? d.body.id : "";
      }
    }
  } catch (err) {
    console.error("[feature-requests] user lookup failed:", (err as Error).message);
  }
  return "";
}

export async function anvilOtpRequest(email: string): Promise<{ message: string; expires_in_seconds?: number }> {
  return anvilFetch("/auth/otp/request", { body: { email, app: APP_SLUG } });
}

export async function anvilOtpVerify(email: string, code: string): Promise<AnvilTokens> {
  return anvilFetch<AnvilTokens>("/auth/otp/verify", { body: { email, code } });
}

export async function anvilChangePassword(userToken: string, currentPassword: string, newPassword: string): Promise<void> {
  await anvilFetch("/auth/change-password", { body: { currentPassword, newPassword }, token: userToken });
}

/** GET /health, for the setup page and tests. */
export async function anvilHealthy(): Promise<boolean> {
  try {
    const r = await anvilFetch<{ status?: string }>("/health");
    return r.status === "ok";
  } catch {
    return false;
  }
}
