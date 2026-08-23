/**
 * Small HTTP helpers shared by the feature-requests routes: an in-memory rate
 * limiter (enough for a single-instance deploy), CORS for the public JSON
 * endpoints the embed calls from other sites, and a JSON response helper.
 */

const buckets = new Map<string, number[]>();

export function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

/** True when `key` has exceeded `max` hits inside `windowMs`. Records the hit otherwise. */
export function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    buckets.set(key, recent);
    return true;
  }
  recent.push(now);
  buckets.set(key, recent);
  if (buckets.size > 20_000) {
    for (const [k, v] of buckets) if (!v.some((t) => now - t < windowMs)) buckets.delete(k);
  }
  return false;
}

/**
 * CORS headers for the embed's cross-site calls. Always permissive: the
 * responses carry no credentials and the origin allow-list is enforced by
 * `originBlocked()` in the handlers, which answer 403 with a message. Sending
 * the headers on those 403s too is what lets the widget show that message
 * instead of a bare "could not reach the server" network error.
 */
export function corsHeaders(_request: Request, _allowedOrigins: string[] = []): Headers {
  const h = new Headers();
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  h.set("Access-Control-Max-Age", "600");
  return h;
}

/** True when an allow-list exists and the request origin is not on it. */
export function originBlocked(request: Request, allowedOrigins: string[]): boolean {
  if (allowedOrigins.length === 0) return false;
  const origin = request.headers.get("origin");
  if (!origin) {
    // Non-browser or same-origin requests carry no Origin header; let the
    // Referer stand in so plain form posts from the board page still work.
    const ref = request.headers.get("referer");
    if (!ref) return true;
    try {
      return !originAllowed(new URL(ref).origin, allowedOrigins);
    } catch {
      return true;
    }
  }
  return !originAllowed(origin, allowedOrigins);
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Exact origin match (scheme, host and port), with one convenience: an entry
 * for a local host without a port (`http://localhost`) matches any port on
 * that host, since dev servers move ports all the time.
 */
export function originAllowed(origin: string, allowedOrigins: string[]): boolean {
  const o = normalizeOrigin(origin);
  if (allowedOrigins.includes(o)) return true;
  let u: URL;
  try {
    u = new URL(o);
  } catch {
    return false;
  }
  if (!LOCAL_HOSTS.has(u.hostname) && !LOCAL_HOSTS.has(`[${u.hostname}]`)) return false;
  return allowedOrigins.some((a) => {
    try {
      const b = new URL(a);
      return b.protocol === u.protocol && b.hostname === u.hostname && b.port === "";
    } catch {
      return false;
    }
  });
}

export function normalizeOrigin(value: string): string {
  try {
    const u = new URL(value.includes("://") ? value : `https://${value}`);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return value.trim().toLowerCase();
  }
}

export function json(data: unknown, init: { status?: number; headers?: Headers | Record<string, string> } = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { status: init.status ?? 200, headers });
}

export function preflight(request: Request, allowedOrigins: string[] = []): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request, allowedOrigins) });
}

/** Parses a JSON or form body into a flat string record. */
export async function readBody(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get("content-type") ?? "";
  const out: Record<string, string> = {};
  if (type.includes("application/json")) {
    try {
      const data = (await request.json()) as Record<string, unknown>;
      for (const [k, v] of Object.entries(data ?? {})) out[k] = typeof v === "string" ? v : v == null ? "" : String(v);
    } catch {
      /* fall through with empty body */
    }
    return out;
  }
  try {
    const form = await request.formData();
    for (const [k, v] of form.entries()) out[k] = typeof v === "string" ? v : "";
  } catch {
    /* empty */
  }
  return out;
}
