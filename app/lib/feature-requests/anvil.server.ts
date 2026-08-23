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
    url: (process.env.ANVIL_URL || "http://localhost:7474").replace(/\/+$/, ""),
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

/** Creates an Anvil user through the admin-only register endpoint; email doubles as username. */
export async function anvilRegister(email: string, password: string): Promise<{ id: string }> {
  const token = await serviceToken();
  try {
    return await anvilFetch<{ id: string }>("/auth/register", { body: { username: email, email, password }, token });
  } catch (err) {
    if (err instanceof AnvilError && err.status === 401 && !getAnvilConfig().serviceKey) {
      return anvilFetch<{ id: string }>("/auth/register", {
        body: { username: email, email, password },
        token: await serviceToken(true),
      });
    }
    throw err;
  }
}

export async function anvilOtpRequest(email: string): Promise<{ message: string; expires_in_seconds?: number }> {
  return anvilFetch("/auth/otp/request", { body: { email } });
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
