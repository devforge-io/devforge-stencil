/**
 * Bearer tokens for the embed widget.
 *
 * The widget runs on other people's sites and calls the JSON API cross-origin
 * with credentials omitted, so the `_fr_session` cookie never reaches it.
 * Instead `/api/auth` signs people in through Anvil and hands back a compact
 * HMAC-signed token the widget keeps in localStorage and sends as
 * `Authorization: Bearer ...` on votes, comments and edits. The token is the
 * only identity the write endpoints trust: an email in the body is ignored.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type EmbedUser = { id: string; email: string; username: string; iat: number };

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is required for the feature-requests tool");
  return s;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function signEmbedToken(user: Omit<EmbedUser, "iat"> & { iat?: number }): string {
  const body: EmbedUser = { id: user.id, email: user.email, username: user.username, iat: user.iat ?? Date.now() };
  const payload = b64url(JSON.stringify(body));
  return `${payload}.${sign(payload)}`;
}

export function verifyEmbedToken(token: string): EmbedUser | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let expected: string;
  try {
    expected = sign(payload);
  } catch {
    return null;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Partial<EmbedUser>;
  if (typeof p.id !== "string" || !p.id || typeof p.email !== "string" || typeof p.iat !== "number") return null;
  if (Date.now() - p.iat > MAX_AGE_MS) return null;
  return { id: p.id, email: p.email, username: typeof p.username === "string" ? p.username : "", iat: p.iat };
}

/** The signed-in widget user from the Authorization header, or null. */
export function embedUser(request: Request): EmbedUser | null {
  const auth = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  return m ? verifyEmbedToken(m[1]) : null;
}
