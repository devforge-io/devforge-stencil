/**
 * Fetches an audit target and everything that sits beside it (robots.txt,
 * sitemap, llms.txt, manifest, favicon, 404 behaviour), then performs a bounded
 * pass of non-intrusive security reconnaissance - TLS handshake, DNS policy
 * records, RDAP registration data, conventional exposed paths, source maps and
 * directory listings.
 *
 * The security-critical part of this module is `assertPublicHttpUrl`. Anything
 * that takes a user-supplied URL and makes a server-side request is an SSRF
 * primitive: without a guard, `http://169.254.169.254/latest/meta-data/` or
 * `http://localhost:5432/` would happily be fetched from inside our network and
 * the response rendered back to the requester. That guard is the single gate all
 * outbound requests pass through - including every redirect hop, because a
 * public host is free to 302 you at a private one.
 *
 * Server-only. Never import from a client module.
 */

import { Resolver, lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
// The https variant of RequestOptions is the http one plus the TLS fields; both
// `http.request` and `https.request` accept it, and the insecure fallback needs
// `rejectUnauthorized`, which the plain http type does not carry.
import type { RequestOptions } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import type { ConnectionOptions, TLSSocket } from "node:tls";
import { parseHtml } from "~/lib/audit/html.server";
import type {
  AuditFailure,
  DnsRecords,
  ExposedPathProbe,
  HttpMethodsProbe,
  PageContext,
  ParsedDocument,
  RdapInfo,
  RedirectHop,
  RobotsGroup,
  RobotsResource,
  SitemapResource,
  SourceMapProbe,
  TextResource,
  TlsInfo
} from "~/lib/audit/types";

/* -------------------------------------------------------------------------- */
/* Tunables                                                                    */
/* -------------------------------------------------------------------------- */

const TOTAL_TIMEOUT_MS = 15_000;
const SIDECAR_TIMEOUT_MS = 6_000;
const MAX_REDIRECTS = 5;
const SIDECAR_MAX_REDIRECTS = 2;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_SIDECAR_BYTES = 2 * 1024 * 1024;
/** Counting `<loc>` across a 50 MB sitemap is not worth the CPU. */
const SITEMAP_SCAN_LIMIT = 2 * 1024 * 1024;

/* Reconnaissance phase. Deliberately tighter than the sidecar budget: these are
 * nice-to-have signals fetched from someone else's server, so they get short
 * timeouts, a low concurrency cap and a hard ceiling on how many requests one
 * audit may send. */
const PROBE_TIMEOUT_MS = 4_000;
const PROBE_MAX_REDIRECTS = 2;
/** Wall-clock ceiling for the entire recon phase, however much is unfinished. */
const RECON_BUDGET_MS = 12_000;
/** Simultaneous in-flight requests to the target across every probe group. */
const RECON_CONCURRENCY = 5;
/** Safety valve: no audit may fire more than this many recon requests. */
const MAX_RECON_REQUESTS = 50;
const MAX_PROBE_BYTES = 64 * 1024;
const MAX_SCRIPT_BYTES = 512 * 1024;
const MAX_SOURCE_MAP_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_MAP_SCRIPTS = 5;
const MAX_SOURCE_MAP_SOURCES = 20;
const TLS_TIMEOUT_MS = 4_000;
const TLS_LEGACY_TIMEOUT_MS = 3_000;
const DNS_CONCURRENCY = 5;
const EXCERPT_LENGTH = 200;

/* RDAP. A little more generous than the other probes because the first hop is a
 * bootstrap redirect and the second lands on a registry server we have no
 * connection to yet - two cold handshakes before a byte of JSON arrives. Still
 * comfortably inside the recon budget it shares with everything else. */
const RDAP_BOOTSTRAP = "https://rdap.org/domain/";
const RDAP_TIMEOUT_MS = 6_000;
const RDAP_MAX_REDIRECTS = 3;
const MAX_RDAP_BYTES = 256 * 1024;
const RDAP_ACCEPT = "application/rdap+json";

const USER_AGENT =
  "Mozilla/5.0 (compatible; DevforgeAudit/1.0; +https://devforge.io/tools/website-audit)";
const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const TEXT_ACCEPT = "text/plain,text/*;q=0.9,*/*;q=0.8";
const ANY_ACCEPT = "*/*";

/** Fixed, not random: a stable path keeps probe results comparable between runs. */
const NOT_FOUND_PROBE_PATH = "/devforge-audit-404-probe-x7f2";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Single-label hosts (`intranet`, `wiki`) and these suffixes only ever resolve
 * inside a private network, so they are rejected before DNS is even consulted.
 */
const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".home.arpa"
];
const BLOCKED_HOST_NAMES = new Set(["localhost", "local", "internal", "broadcasthost"]);

/** MIME types that may plausibly carry an HTML document. */
const HTML_MIME_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
  "text/plain"
]);

/* -------------------------------------------------------------------------- */
/* Failures                                                                    */
/* -------------------------------------------------------------------------- */

function fail(code: AuditFailure["code"], message: string, status?: number): AuditFailure {
  return status === undefined ? { ok: false, code, message } : { ok: false, code, message, status };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    // undici wraps the useful bit ("ECONNREFUSED", "certificate expired") in `cause`.
    const cause: unknown = error.cause;
    if (cause instanceof Error && cause.message) return `${error.message}: ${cause.message}`;
    return error.message;
  }
  return String(error);
}

/* -------------------------------------------------------------------------- */
/* URL normalisation                                                           */
/* -------------------------------------------------------------------------- */

/** Schemes a user might paste that can never be a web page we should fetch. */
const NON_WEB_SCHEME_RE = /^(mailto|javascript|data|file|ftp|ftps|tel|sms|about|blob|chrome|view-source|ws|wss):/i;

/**
 * Turns whatever the user typed into an absolute http(s) URL, or `null` when it
 * cannot be one. Does *not* perform any security checks - see
 * `assertPublicHttpUrl` for that.
 */
export function normaliseUrl(input: string): string | null {
  const trimmed = input.trim().replace(/^[<"']+|[>"']+$/g, "");
  if (!trimmed) return null;
  if (NON_WEB_SCHEME_RE.test(trimmed)) return null;

  let candidate: string;
  if (trimmed.startsWith("//")) {
    // Protocol-relative paste.
    candidate = `https:${trimmed}`;
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    candidate = trimmed;
  } else {
    // Bare hosts are the common case ("devforge.io", "devforge.io:8443/path").
    // The scheme test above deliberately requires "://" so that a host:port pair
    // is not mistaken for a scheme.
    candidate = `https://${trimmed}`;
  }

  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* SSRF guard                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * IPv4 ranges that must never be reachable through a user-supplied URL.
 *
 * 169.254.0.0/16 matters most in practice: that is where the AWS/GCP/Azure
 * instance metadata service lives (169.254.169.254), and reading it leaks
 * credentials. The rest are RFC 1918 private space, loopback, CGNAT and the
 * various IANA-reserved blocks.
 */
function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) return false;

  const octets: number[] = [];
  for (const part of parts) {
    // Reject non-canonical forms ("0177", "0x7f") outright rather than guessing
    // how the resolver would interpret them.
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number.parseInt(part, 10);
    if (value < 0 || value > 255) return false;
    octets.push(value);
  }

  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol + TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** IPv6 equivalents, including the mapped forms that tunnel to an IPv4 target. */
function isPrivateIpv6(address: string): boolean {
  // Strip brackets and any zone id ("fe80::1%eth0").
  const addr = address.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").split("%")[0];
  if (addr === "::1" || addr === "::") return true;

  // ::ffff:127.0.0.1 and ::127.0.0.1 both reach IPv4 loopback.
  const dotted = /^::(?:ffff:)?(?:0:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (dotted) return isPrivateIpv4(dotted[1]);

  // Some stacks print the same address in hex: ::ffff:7f00:1
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
  if (hex) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return isPrivateIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }

  const head = Number.parseInt(addr.split(":")[0] || "0", 16);
  if (!Number.isFinite(head)) return false;
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((head & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  // Not a literal at all - the caller should be resolving it instead.
  return false;
}

/**
 * The one and only outbound-request gate.
 *
 * Runs the full chain: scheme check, hostname denylist, IP-literal range check,
 * then a real DNS resolution whose every answer must be public. The DNS step is
 * what stops `internal.example.com IN A 10.0.0.5` and the first half of a
 * DNS-rebinding attack; it cannot close the rebinding window entirely, since the
 * resolver could hand the socket a different address moments later, but doing it
 * here means an attacker needs a race rather than just a hostname.
 *
 * Exported so route handlers (e.g. the image proxy) validate through exactly the
 * same code path the fetcher does - there must never be a second implementation.
 */
export async function assertPublicHttpUrl(
  rawUrl: string
): Promise<{ ok: true; url: URL } | AuditFailure> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // Be forgiving about a missing scheme; the checks below are unaffected.
    const normalised = normaliseUrl(rawUrl);
    if (!normalised) return fail("invalid-url", `"${rawUrl}" is not a URL we can fetch.`);
    url = new URL(normalised);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail("blocked-host", `Only http and https URLs can be fetched (got "${url.protocol}").`);
  }

  // Trailing dot is the DNS root and must not let "localhost." slip past.
  const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[/, "").replace(/\]$/, "");
  if (!host) return fail("invalid-url", "The URL has no hostname.");

  if (BLOCKED_HOST_NAMES.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    return fail("blocked-host", `"${host}" is a private or loopback hostname.`);
  }

  const literalFamily = isIP(host);
  if (literalFamily !== 0) {
    if (isPrivateAddress(host)) {
      return fail("blocked-host", `"${host}" is a private or reserved IP address.`);
    }
    // A public IP literal needs no DNS round-trip.
    return { ok: true, url };
  }

  // Numeric-looking hosts that are not valid dotted quads are the classic
  // encoding dodge for loopback: 2130706433, 0x7f000001, 0177.0.0.1.
  if (/^[0-9.]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    return fail("blocked-host", `"${host}" is not a valid public hostname.`);
  }

  // No dot means a single-label intranet name. A bare public suffix ("com") is
  // never a real site either, so rejecting the whole class costs us nothing.
  if (!host.includes(".")) {
    return fail("blocked-host", `"${host}" is not a public hostname.`);
  }

  let records: { address: string; family: number }[];
  try {
    records = await lookup(host, { all: true });
  } catch (error) {
    return fail("dns-failure", `Could not resolve "${host}": ${describeError(error)}`);
  }

  if (records.length === 0) {
    return fail("dns-failure", `"${host}" did not resolve to any address.`);
  }

  for (const record of records) {
    // Reject if ANY answer is private - a host that returns one public and one
    // private address is either misconfigured or attacking us.
    const isPrivate =
      record.family === 6 ? isPrivateIpv6(record.address) : isPrivateIpv4(record.address);
    if (isPrivate) {
      return fail("blocked-host", `"${host}" resolves to the private address ${record.address}.`);
    }
  }

  return { ok: true, url };
}

/* -------------------------------------------------------------------------- */
/* Deadlines and guarded fetching                                              */
/* -------------------------------------------------------------------------- */

interface Deadline {
  signal: AbortSignal;
  /** Why we aborted, so the caller can pick the right failure code. */
  state: { reason: "timeout" | "too-large" | null };
  abortForSize: () => void;
  dispose: () => void;
}

function createDeadline(ms: number): Deadline {
  const controller = new AbortController();
  const state: Deadline["state"] = { reason: null };
  const timer = setTimeout(() => {
    state.reason = "timeout";
    controller.abort();
  }, ms);
  return {
    signal: controller.signal,
    state,
    abortForSize: () => {
      state.reason = "too-large";
      controller.abort();
    },
    dispose: () => clearTimeout(timer)
  };
}

/**
 * An `AuditFailure` carrying the transport's own error code.
 *
 * `AuditFailure.code` is the coarse, user-facing category; `errorCode` is the
 * raw OpenSSL/libuv string underneath it, which is what lets the caller tell a
 * broken certificate apart from a refused connection. It is stripped before the
 * failure leaves this module - the client has no business seeing it.
 */
interface FetchFailure extends AuditFailure {
  errorCode?: string;
}

/** undici buries the interesting code one level down in `cause`. */
function errorCodeOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const own = (error as SocketError).code;
  if (typeof own === "string" && own) return own;
  const cause: unknown = error.cause;
  if (cause instanceof Error) {
    const inner = (cause as SocketError).code;
    if (typeof inner === "string" && inner) return inner;
  }
  return undefined;
}

function abortToFailure(error: unknown, deadline: Deadline, seconds: number): FetchFailure {
  if (deadline.state.reason === "timeout") {
    return fail("timeout", `The site did not respond within ${seconds} seconds.`);
  }
  if (deadline.state.reason === "too-large") {
    return fail("too-large", `The response exceeded the ${MAX_HTML_BYTES / 1024 / 1024} MB limit.`);
  }
  const failure: FetchFailure = fail(
    "network-error",
    `Could not reach the site - ${describeError(error)}`
  );
  const errorCode = errorCodeOf(error);
  if (errorCode) failure.errorCode = errorCode;
  return failure;
}

/** Drops the internal diagnostic before a failure is returned to a caller. */
function publicFailure(failure: FetchFailure): AuditFailure {
  return failure.status === undefined
    ? { ok: false, code: failure.code, message: failure.message }
    : { ok: false, code: failure.code, message: failure.message, status: failure.status };
}

interface SafeFetchOk {
  ok: true;
  response: Response;
  redirects: RedirectHop[];
  finalUrl: string;
  /** Time to response headers, measured from the first request in the chain. */
  ttfbMs: number;
}

interface SafeFetchOptions {
  deadline: Deadline;
  maxRedirects: number;
  /**
   * Safe, non-mutating methods only. Nothing here may write to the target -
   * that is a hard scope rule for this tool, not merely a default.
   */
  method?: "GET" | "HEAD" | "OPTIONS";
  accept?: string;
  /**
   * Hand the 3xx back to the caller instead of following it. Probes that are
   * interested in the redirect *itself* (does http bounce to https?) need the
   * hop's own status and Location, which following would throw away.
   */
  stopAtRedirect?: boolean;
  /**
   * Skip certificate validation for this request only. Set exclusively by the
   * insecure-fallback path, after the certificate has already been established
   * as broken and reporting on it is the entire point. Never a default.
   */
  insecure?: boolean;
}

/** Statuses the Response constructor refuses to pair with a body. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * Performs one request with certificate validation switched off, returning a
 * standard `Response` so the rest of the pipeline cannot tell the difference.
 *
 * Why not `fetch`? Because relaxing validation for a single `fetch` call means
 * handing it an undici `Agent` as a `dispatcher`, and undici is not a
 * dependency of this project. The alternative - `NODE_TLS_REJECT_UNAUTHORIZED`
 * - is process-global: it would silently disable certificate checking for the
 * contact form's Resend calls, every other outbound request in the app, and
 * every concurrent audit, for the lifetime of the process. That is not a
 * trade worth making for a diagnostic. `node:https` takes the flag per request,
 * which is exactly the scope we want, so the fallback is built on that instead.
 *
 * The relaxation is deliberately narrow: this connection only, chosen once, and
 * always recorded in `PageContext.insecureFallback`.
 */
function insecureRequest(
  url: URL,
  options: { method: string; accept: string; signal: AbortSignal }
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new Error("The request was aborted before it started."));
      return;
    }

    const secure = url.protocol === "https:";
    const requestOptions: RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (secure ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: options.method,
      headers: {
        "user-agent": USER_AGENT,
        accept: options.accept,
        "accept-language": "en-US,en;q=0.9",
        // `node:https` will not decompress for us the way `fetch` does, so ask
        // for none and keep the byte accounting downstream honest.
        "accept-encoding": "identity"
      },
      // The point of this path. Scoped to this single request object.
      rejectUnauthorized: false,
      // Sites with a certificate this broken are often equally out of date on
      // protocol versions, and failing the retry on a handshake would put us
      // right back where we started. Lowering the security level changes only
      // what this client is willing to speak.
      ...(secure
        ? {
            // SNI must be a name; sending an IP literal is a protocol violation.
            servername: isIP(url.hostname) === 0 ? url.hostname : undefined,
            minVersion: "TLSv1" as const,
            ciphers: "DEFAULT@SECLEVEL=0"
          }
        : {})
    };

    const request = (secure ? httpsRequest : httpRequest)(requestOptions, (response) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        // `set-cookie` is the one header Node hands back as an array.
        for (const entry of Array.isArray(value) ? value : [value]) {
          try {
            headers.append(key, entry);
          } catch {
            // A header name the Headers class rejects is not worth failing over.
          }
        }
      }

      const status = response.statusCode ?? 502;
      const body = NULL_BODY_STATUSES.has(status)
        ? null
        : (Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>);
      resolve(new Response(body, { status, headers }));
    });

    // Destroying the request tears down the socket, which errors the response
    // stream mid-read too - so the size and time caps still bite once the body
    // is flowing, exactly as they do for `fetch`.
    options.signal.addEventListener("abort", () => request.destroy(), { once: true });
    request.on("error", reject);
    request.end();
  });
}

/**
 * Fetches a URL with redirects followed by hand.
 *
 * `redirect: "manual"` is not an optimisation - it is what makes the SSRF guard
 * sound. `redirect: "follow"` would let undici chase a 302 to 127.0.0.1 without
 * ever asking us, so every hop is re-validated here instead.
 *
 * The insecure transport goes through this same loop for the same reason: the
 * guard must run on every hop whether or not certificates are being checked.
 */
async function safeFetch(target: string, options: SafeFetchOptions): Promise<SafeFetchOk | FetchFailure> {
  const { deadline, maxRedirects } = options;
  const redirects: RedirectHop[] = [];
  const startedAt = Date.now();
  let currentUrl = target;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const guard = await assertPublicHttpUrl(currentUrl);
    if (!guard.ok) return guard;

    let response: Response;
    try {
      response = options.insecure
        ? await insecureRequest(guard.url, {
            method: options.method ?? "GET",
            accept: options.accept ?? HTML_ACCEPT,
            signal: deadline.signal
          })
        : await fetch(guard.url.href, {
            method: options.method ?? "GET",
            redirect: "manual",
            signal: deadline.signal,
            headers: {
              "user-agent": USER_AGENT,
              accept: options.accept ?? HTML_ACCEPT,
              "accept-language": "en-US,en;q=0.9"
            }
          });
    } catch (error) {
      return abortToFailure(error, deadline, Math.round(TOTAL_TIMEOUT_MS / 1000));
    }

    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || !location || options.stopAtRedirect) {
      // A 3xx with no Location is a dead end; report it as the final response.
      return {
        ok: true,
        response,
        redirects,
        finalUrl: guard.url.href,
        ttfbMs: Date.now() - startedAt
      };
    }

    if (hop === maxRedirects) {
      await cancelBody(response);
      return fail("network-error", `Too many redirects - gave up after ${maxRedirects} hops.`);
    }

    let next: string;
    try {
      next = new URL(location, guard.url.href).href;
    } catch {
      await cancelBody(response);
      return fail("network-error", `Redirected to an unparseable location: "${location}".`);
    }

    // Release the socket before moving on; we never read a redirect body.
    await cancelBody(response);
    redirects.push({ from: guard.url.href, to: next, status: response.status });
    currentUrl = next;
  }

  return fail("network-error", `Too many redirects - gave up after ${maxRedirects} hops.`);
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The stream may already be errored or locked; nothing to do.
  }
}

/* -------------------------------------------------------------------------- */
/* Body reading                                                                */
/* -------------------------------------------------------------------------- */

interface ReadResult {
  bytes: Uint8Array;
  /** Uncompressed byte length as it came off the stream. */
  length: number;
}

/**
 * Streams a response body, aborting the moment it exceeds `limit`.
 *
 * Reading first and checking `Content-Length` afterwards would let a server with
 * a lying (or absent) header stream us gigabytes, so the cap is enforced chunk
 * by chunk.
 */
async function readCapped(
  response: Response,
  limit: number,
  deadline: Deadline
): Promise<ReadResult | "too-large"> {
  const body = response.body;
  if (!body) return { bytes: new Uint8Array(0), length: 0 };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    length += value.byteLength;
    if (length > limit) {
      deadline.abortForSize();
      await reader.cancel().catch(() => undefined);
      return "too-large";
    }
    chunks.push(value);
  }

  return { bytes: Buffer.concat(chunks), length };
}

function charsetFromContentType(contentType: string): string | null {
  const match = /charset\s*=\s*"?([\w-]+)/i.exec(contentType);
  return match ? match[1].toLowerCase() : null;
}

function decodeBytes(bytes: Uint8Array, label: string | null): string {
  try {
    return new TextDecoder(label ?? "utf-8").decode(bytes);
  } catch {
    // Unknown/unsupported label - utf-8 is the only sane fallback.
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/**
 * Decodes an HTML body, honouring the transport charset and, failing that, a
 * `<meta charset>` in the first 2 KB. Legacy sites still ship windows-1252 with
 * no `Content-Type` charset, and mis-decoding mangles every quote and dash in
 * the title we are about to grade.
 */
function decodeHtml(bytes: Uint8Array, contentType: string): string {
  const transportCharset = charsetFromContentType(contentType);
  if (transportCharset) return decodeBytes(bytes, transportCharset);

  const head = decodeBytes(bytes.subarray(0, 2048), "utf-8");
  const declared =
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head) ??
    /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i.exec(head);
  const label = declared?.[1].toLowerCase();
  if (label && label !== "utf-8" && label !== "utf8") return decodeBytes(bytes, label);
  return decodeBytes(bytes, "utf-8");
}

function looksLikeHtml(body: string): boolean {
  const head = body.slice(0, 512).trimStart().toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<?xml");
}

/* -------------------------------------------------------------------------- */
/* Sidecar resources                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Best-effort GET of a sibling text file. Every failure mode - blocked host,
 * timeout, oversized body, network error - collapses to `null`, because none of
 * these should sink an otherwise successful audit.
 */
async function fetchTextResource(
  url: string,
  accept = TEXT_ACCEPT,
  insecure = false
): Promise<TextResource | null> {
  const deadline = createDeadline(SIDECAR_TIMEOUT_MS);
  try {
    const result = await safeFetch(url, {
      deadline,
      maxRedirects: SIDECAR_MAX_REDIRECTS,
      accept,
      insecure
    });
    if (!result.ok) return null;

    const read = await readCapped(result.response, MAX_SIDECAR_BYTES, deadline);
    if (read === "too-large") return null;

    const contentType = result.response.headers.get("content-type");
    return {
      url: result.finalUrl,
      ok: result.response.ok,
      status: result.response.status,
      contentType,
      body: decodeBytes(read.bytes, charsetFromContentType(contentType ?? "")),
      bytes: read.length
    };
  } catch {
    return null;
  } finally {
    deadline.dispose();
  }
}

/** Status-only probe; the body is discarded. */
async function probeStatus(
  url: string,
  method: "GET" | "HEAD" = "GET",
  insecure = false
): Promise<number | null> {
  const deadline = createDeadline(SIDECAR_TIMEOUT_MS);
  try {
    const result = await safeFetch(url, {
      deadline,
      maxRedirects: SIDECAR_MAX_REDIRECTS,
      method,
      accept: "*/*",
      insecure
    });
    if (!result.ok) return null;
    await cancelBody(result.response);
    return result.response.status;
  } catch {
    return null;
  } finally {
    deadline.dispose();
  }
}

/**
 * Parses robots.txt into groups.
 *
 * Consecutive `User-agent:` lines share one group - `User-agent: a` followed by
 * `User-agent: b` then `Disallow: /x` applies that rule to both agents. A rule
 * line closes the agent list, so the next `User-agent:` starts a fresh group.
 */
function parseRobotsTxt(body: string): {
  groups: RobotsGroup[];
  sitemaps: string[];
  blocksAllCrawlers: boolean;
} {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const rawLine of body.split(/\r?\n/)) {
    // Strip comments, but only when the "#" starts the line or follows
    // whitespace - sitemap URLs may legitimately contain one.
    const line = rawLine.replace(/^\s*#.*$/, "").replace(/\s+#.*$/, "").trim();
    if (!line) continue;

    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { userAgents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      if (value) current.userAgents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }

    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }

    if (field === "allow" || field === "disallow") {
      if (!current) {
        // Rules before any User-agent line: treat as the catch-all group.
        current = { userAgents: ["*"], allow: [], disallow: [] };
        groups.push(current);
      }
      lastWasAgent = false;
      if (field === "allow") current.allow.push(value);
      else current.disallow.push(value);
    }
  }

  const blocksAllCrawlers = groups.some(
    (group) => group.userAgents.includes("*") && group.disallow.some((rule) => rule.trim() === "/")
  );

  return { groups, sitemaps, blocksAllCrawlers };
}

async function fetchRobots(origin: string, insecure: boolean): Promise<RobotsResource | null> {
  const resource = await fetchTextResource(`${origin}/robots.txt`, TEXT_ACCEPT, insecure);
  if (!resource) return null;
  // A 404 robots.txt is still worth reporting, but parsing an HTML error page
  // into "groups" would invent rules that do not exist.
  const parsed =
    resource.ok && !looksLikeHtml(resource.body)
      ? parseRobotsTxt(resource.body)
      : { groups: [], sitemaps: [], blocksAllCrawlers: false };
  return { ...resource, ...parsed };
}

/**
 * Tries the candidate sitemap locations in priority order and returns the first
 * that responds. When nothing is found we still return a record for the
 * well-known path with `ok: false`, which is strictly more useful to a check
 * than `null` - it can report the status it actually got.
 */
async function fetchSitemap(
  origin: string,
  robotsSitemap: string | undefined,
  linkTagSitemap: string | undefined,
  insecure: boolean
): Promise<SitemapResource | null> {
  const candidates: { url: string; source: SitemapResource["source"] }[] = [];
  if (robotsSitemap) candidates.push({ url: robotsSitemap, source: "robots" });
  candidates.push({ url: `${origin}/sitemap.xml`, source: "well-known" });
  if (linkTagSitemap) candidates.push({ url: linkTagSitemap, source: "link-tag" });

  let fallback: SitemapResource | null = null;

  for (const candidate of candidates) {
    const resource = await fetchTextResource(
      candidate.url,
      "application/xml,text/xml;q=0.9,*/*;q=0.8",
      insecure
    );
    if (!resource) continue;

    const scanned = resource.body.slice(0, SITEMAP_SCAN_LIMIT);
    // Namespace prefixes ("sm:loc") are legal and common in generated sitemaps.
    const isIndex = /<(?:[a-z0-9]+:)?sitemapindex[\s>]/i.test(scanned);
    const urlCount = scanned.match(/<(?:[a-z0-9]+:)?loc[\s>]/gi)?.length ?? 0;
    const ok = resource.ok && !looksLikeHtml(resource.body) && urlCount > 0;

    const record: SitemapResource = {
      url: resource.url,
      ok,
      status: resource.status,
      isIndex,
      urlCount,
      source: candidate.source
    };
    if (ok) return record;
    fallback ??= record;
  }

  return fallback;
}

async function fetchManifest(
  url: string,
  insecure: boolean
): Promise<{ url: string; ok: boolean; parsed: Record<string, unknown> | null } | null> {
  const resource = await fetchTextResource(
    url,
    "application/manifest+json,application/json;q=0.9",
    insecure
  );
  if (!resource) return null;

  let parsed: Record<string, unknown> | null = null;
  if (resource.ok) {
    try {
      const value: unknown = JSON.parse(resource.body);
      // A manifest must be an object; an array or scalar is malformed.
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      parsed = null;
    }
  }

  return { url: resource.url, ok: resource.ok && parsed !== null, parsed };
}

/**
 * Some hosts answer every path with a 200 HTML shell, so `llms.txt` is only
 * counted as present when the status is 200 *and* the body is not markup.
 */
async function fetchLlmsTxt(origin: string, insecure: boolean): Promise<TextResource | null> {
  const resource = await fetchTextResource(`${origin}/llms.txt`, TEXT_ACCEPT, insecure);
  if (!resource) return null;
  return { ...resource, ok: resource.status === 200 && !looksLikeHtml(resource.body) };
}

/**
 * A site that answers a nonsense path with 200 has no real 404 handling.
 *
 * The body is kept (and stripped off before it reaches `PageContext`) because
 * the exposure probes need something to compare against: knowing exactly what
 * this host serves for a path that certainly does not exist is what lets them
 * tell a real `/.env` from an SPA catch-all.
 */
async function probeNotFound(
  origin: string,
  insecure: boolean
): Promise<{ status: number; isSoft404: boolean; body: string } | null> {
  const resource = await fetchTextResource(
    `${origin}${NOT_FOUND_PROBE_PATH}`,
    ANY_ACCEPT,
    insecure
  );
  if (!resource) return null;
  return { status: resource.status, isSoft404: resource.status === 200, body: resource.body };
}

/** Does the naked http origin bounce to https? Meaningless when the site is http-only. */
async function probeHttpsRedirect(
  finalUrl: URL
): Promise<{ checked: boolean; redirectsToHttps: boolean }> {
  if (finalUrl.protocol !== "https:") return { checked: false, redirectsToHttps: false };

  const deadline = createDeadline(SIDECAR_TIMEOUT_MS);
  try {
    // Drop any custom port: `http://host:8443/` is not what a visitor would type.
    // `stopAtRedirect` is load-bearing: the 3xx *is* the answer here, and
    // following it would both waste a request and discard the Location we came
    // to read.
    const result = await safeFetch(`http://${finalUrl.hostname}/`, {
      deadline,
      maxRedirects: 0,
      accept: HTML_ACCEPT,
      stopAtRedirect: true
    });
    if (!result.ok) return { checked: false, redirectsToHttps: false };

    const location = result.response.headers.get("location");
    await cancelBody(result.response);
    const redirectsToHttps =
      REDIRECT_STATUSES.has(result.response.status) &&
      location !== null &&
      new URL(location, `http://${finalUrl.hostname}/`).protocol === "https:";
    return { checked: true, redirectsToHttps };
  } catch {
    return { checked: false, redirectsToHttps: false };
  } finally {
    deadline.dispose();
  }
}

/* ========================================================================== */
/* Security reconnaissance                                                    */
/* ========================================================================== */

/**
 * Everything below is *non-intrusive* reconnaissance: plain GET/OPTIONS/TRACE
 * requests to conventional, well-known paths, standard DNS queries and an
 * ordinary TLS handshake - the same class of traffic securityheaders.com,
 * Mozilla Observatory or SSL Labs send. There are deliberately no payloads, no
 * traversal, no credential guessing, no port scanning and nothing that writes
 * to the target. If a probe would only be interesting because it *changed*
 * something, it does not belong in this file.
 *
 * It is also entirely optional. The document has been fetched, decoded and
 * parsed before any of this runs, so every probe fails soft to `null`/`[]` and
 * the whole phase sits behind one hard wall-clock budget. A slow certificate
 * chain or a tarpitting server must never cost the user their report.
 */

/* -------------------------------------------------------------------------- */
/* Recon plumbing: politeness gate, request budget, capped reads               */
/* -------------------------------------------------------------------------- */

interface ReconSession {
  /**
   * Runs `task` once a slot is free and the request budget allows it, otherwise
   * resolves `null`. Every probe group shares one session, so the concurrency
   * cap is a promise about total load on the target rather than per-group.
   */
  run<T>(task: () => Promise<T>): Promise<T | null>;
  /**
   * True when the document itself could only be fetched with certificate
   * validation off. The probes have to make the same allowance or every one of
   * them fails the handshake, and a broken-certificate site would be reported
   * as having no exposed files simply because we could not look.
   */
  insecure: boolean;
  /** Drop everything still queued - the phase is over, stop knocking. */
  close(): void;
}

function createReconSession(
  concurrency: number,
  maxRequests: number,
  insecure: boolean
): ReconSession {
  let active = 0;
  let remaining = maxRequests;
  let closed = false;
  const waiting: (() => void)[] = [];

  return {
    insecure,
    async run<T>(task: () => Promise<T>): Promise<T | null> {
      if (closed || remaining <= 0) return null;
      if (active >= concurrency) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      active++;
      try {
        // Re-check: the budget may have expired while we sat in the queue.
        if (closed || remaining <= 0) return null;
        remaining--;
        return await task();
      } finally {
        active--;
        // Always hand the slot on, including after a bail-out, or the queue
        // stalls with capacity to spare.
        waiting.shift()?.();
      }
    },
    close() {
      closed = true;
      while (waiting.length > 0) waiting.shift()?.();
    }
  };
}

interface ProbeResult {
  url: string;
  status: number;
  ok: boolean;
  contentType: string | null;
  bytes: Uint8Array;
  /** Bytes retained, which is the cap when the body was longer. */
  length: number;
  truncated: boolean;
  text: string;
  /** True when at least one redirect hop was followed to get here. */
  redirected: boolean;
}

/**
 * Reads at most `limit` bytes and then walks away.
 *
 * Unlike `readCapped`, hitting the cap is not an error here: a 40 MB
 * `backup.sql` is exactly the finding we care about, and aborting the whole
 * probe because it is large would hide it. We keep the head, note the
 * truncation and release the socket.
 */
async function readTruncated(
  response: Response,
  limit: number
): Promise<{ bytes: Uint8Array; length: number; truncated: boolean }> {
  const body = response.body;
  if (!body) return { bytes: new Uint8Array(0), length: 0, truncated: false };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    length += value.byteLength;
    if (length >= limit) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }

  const merged = Buffer.concat(chunks);
  const bytes = merged.byteLength > limit ? merged.subarray(0, limit) : merged;
  return { bytes, length: bytes.byteLength, truncated };
}

/** A single guarded, capped, short-deadline GET. Every failure becomes `null`. */
async function reconGet(
  session: ReconSession,
  url: string,
  options: { limit: number; accept?: string } = { limit: MAX_PROBE_BYTES }
): Promise<ProbeResult | null> {
  return session.run(async () => {
    const deadline = createDeadline(PROBE_TIMEOUT_MS);
    try {
      const result = await safeFetch(url, {
        deadline,
        maxRedirects: PROBE_MAX_REDIRECTS,
        accept: options.accept ?? ANY_ACCEPT,
        insecure: session.insecure
      });
      // `safeFetch` re-runs the SSRF guard on every hop, so a probe that gets
      // redirected at a private host is refused rather than followed.
      if (!result.ok) return null;

      const read = await readTruncated(result.response, options.limit);
      const contentType = result.response.headers.get("content-type");
      return {
        url: result.finalUrl,
        status: result.response.status,
        ok: result.response.ok,
        contentType,
        bytes: read.bytes,
        length: read.length,
        truncated: read.truncated,
        text: decodeBytes(read.bytes, charsetFromContentType(contentType ?? "")),
        redirected: result.redirects.length > 0
      };
    } catch {
      return null;
    } finally {
      deadline.dispose();
    }
  });
}

/**
 * Runs `worker` over `items` at bounded concurrency.
 *
 * Results are written into `sink` at the item's own index as each one lands
 * rather than gathered at the end, so a caller that stops waiting still holds
 * everything that finished. Pre-fill the sink with "not attempted" records and
 * a blown budget degrades to partial results instead of no results.
 */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  sink: R[] = new Array<R>(items.length)
): Promise<R[]> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      sink[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return sink;
}

function isHtmlResponse(probe: ProbeResult): boolean {
  const mime = (probe.contentType ?? "").split(";")[0].trim().toLowerCase();
  if (mime === "text/html" || mime === "application/xhtml+xml") return true;
  const head = probe.text.slice(0, 512).trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.includes("<html");
}

/* -------------------------------------------------------------------------- */
/* TLS                                                                         */
/* -------------------------------------------------------------------------- */

type SocketError = Error & { code?: string };

type TlsOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: SocketError | null; timedOut: boolean };

/**
 * Opens one TLS connection, hands the live socket to `read`, and guarantees the
 * socket is destroyed on every exit path - success, error, timeout or a throw
 * inside `read`. A leaked TLS handle keeps the event loop alive long after the
 * report has been served.
 */
function inspectTlsSocket<T>(
  options: ConnectionOptions,
  timeoutMs: number,
  read: (socket: TLSSocket) => T
): Promise<TlsOutcome<T>> {
  return new Promise<TlsOutcome<T>>((resolve) => {
    let socket: TLSSocket | null = null;
    let settled = false;

    const finish = (outcome: TlsOutcome<T>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        // Already torn down; nothing to release.
      }
      resolve(outcome);
    };

    const timer = setTimeout(() => finish({ ok: false, error: null, timedOut: true }), timeoutMs);

    try {
      socket = tlsConnect(options, () => {
        if (!socket) return;
        try {
          finish({ ok: true, value: read(socket) });
        } catch {
          finish({ ok: false, error: null, timedOut: false });
        }
      });
      socket.on("error", (error: SocketError) => finish({ ok: false, error, timedOut: false }));
      // A clean close before the handshake completed is a refusal we cannot
      // attribute, so it lands in the same inconclusive bucket as an error.
      socket.on("close", () => finish({ ok: false, error: null, timedOut: false }));
    } catch (error) {
      // `connect` throws synchronously for invalid options (e.g. a protocol
      // version this Node build refuses to speak at all).
      finish({
        ok: false,
        error: error instanceof Error ? (error as SocketError) : null,
        timedOut: false
      });
    }
  });
}

/** Reads a string field off a certificate record without trusting its shape. */
function certField(source: unknown, key: string): string | null {
  if (!source || typeof source !== "object") return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function certNumber(source: unknown, key: string): number | null {
  if (!source || typeof source !== "object") return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Node hands us "Jan  1 00:00:00 2026 GMT"; the report wants ISO. */
function toIsoDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** "DNS:example.com, DNS:*.example.com, IP Address:1.2.3.4" -> the names. */
function parseSubjectAltNames(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^DNS:/i, "").trim())
    .filter(Boolean);
}

/**
 * Hostname matching per RFC 6125, minus the parts nobody uses: exactly one
 * leading `*.` wildcard, and it covers exactly one label - `*.a.com` matches
 * `b.a.com` but not `c.b.a.com` and not the bare `a.com`.
 */
function certNameMatches(host: string, pattern: string): boolean {
  const target = host.toLowerCase().replace(/\.$/, "");
  const candidate = pattern.toLowerCase().trim().replace(/\.$/, "");
  if (!target || !candidate) return false;
  if (candidate === target) return true;
  if (!candidate.startsWith("*.")) return false;

  const suffix = candidate.slice(1); // ".a.com"
  if (suffix.length < 2 || !target.endsWith(suffix)) return false;
  const label = target.slice(0, target.length - suffix.length);
  return label.length > 0 && !label.includes(".");
}

/** `authorizationError` is documented as an Error but is a code string at runtime. */
function describeAuthorizationError(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    const code = (value as SocketError).code;
    return code ?? value.message ?? null;
  }
  return String(value);
}

function canonicalName(source: unknown): string {
  if (!source || typeof source !== "object") return "";
  const record = source as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .map((key) => `${key}=${String(record[key])}`)
    .join(",");
}

const SELF_SIGNED_ERRORS = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN"
]);

/**
 * Probes whether the server still speaks a deprecated protocol version.
 *
 * `true` = accepted (bad), `false` = the server refused, `null` = we could not
 * tell. The distinction matters: our own OpenSSL 3 build refuses TLS 1.0/1.1
 * outright unless the security level is lowered, and reporting that local
 * refusal as "the server is fine" would be a lie. `SECLEVEL=0` only relaxes
 * what *we* are willing to offer - it changes nothing about the target.
 */
async function probeLegacyProtocol(
  target: URL,
  version: "TLSv1" | "TLSv1.1"
): Promise<boolean | null> {
  const guard = await assertPublicHttpUrl(target.href);
  if (!guard.ok) return null;

  const host = guard.url.hostname;
  const port = guard.url.port ? Number.parseInt(guard.url.port, 10) : 443;

  const outcome = await inspectTlsSocket(
    {
      host,
      port,
      servername: isIP(host) === 0 ? host : undefined,
      rejectUnauthorized: false,
      minVersion: version,
      maxVersion: version,
      ciphers: "DEFAULT@SECLEVEL=0"
    },
    TLS_LEGACY_TIMEOUT_MS,
    () => true
  );

  if (outcome.ok) return true;
  if (outcome.timedOut) return null;

  const detail = `${outcome.error?.code ?? ""} ${outcome.error?.message ?? ""}`;
  // Our side could not even offer the version - inconclusive, not a pass.
  if (/NO_PROTOCOLS_AVAILABLE|INVALID_PROTOCOL_VERSION|no protocols available/i.test(detail)) {
    return null;
  }
  // A protocol alert, a reset or a version mismatch is the server saying no.
  if (
    /PROTOCOL_VERSION|UNSUPPORTED_PROTOCOL|WRONG_VERSION_NUMBER|ECONNRESET|EPROTO|HANDSHAKE_FAILURE|SSLV3_ALERT/i.test(
      detail
    )
  ) {
    return false;
  }
  return null;
}

/**
 * Handshakes with the final host and reports what the certificate actually
 * says. `fetch` cannot do this: it exposes neither the peer certificate nor the
 * negotiated protocol, and it refuses the connection outright when the chain is
 * untrusted - which is precisely the case we most want to describe.
 */
async function probeTls(target: URL, insecure = false): Promise<TlsInfo | null> {
  // Nothing to inspect on a plain-http target; the check module reports the
  // missing https instead.
  if (target.protocol !== "https:") return null;

  const guard = await assertPublicHttpUrl(target.href);
  if (!guard.ok) return null;

  const host = guard.url.hostname;
  const port = guard.url.port ? Number.parseInt(guard.url.port, 10) : 443;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;

  const connectOptions: ConnectionOptions = {
    host,
    port,
    // SNI must be a name; sending an IP literal is a protocol violation.
    servername: isIP(host) === 0 ? host : undefined,
    // Deliberately permissive: we want to *report* an invalid chain, not throw
    // on it. `authorized` below carries the verdict.
    rejectUnauthorized: false,
    ALPNProtocols: ["http/1.1"],
    /*
     * Normal audits keep this client's strict defaults, so `protocol` and
     * `cipher` describe what a real browser would actually negotiate.
     *
     * When the document already needed the insecure transport the server is
     * known to be pre-TLS-1.2, and strict defaults would fail the handshake and
     * report nothing at all - leaving the site with a page but no TLS section,
     * which is the very thing this fallback exists to prevent. Lowering the
     * floor cannot inflate the result: the server still picks the highest
     * version and its preferred cipher from what we offer.
     */
    ...(insecure ? { minVersion: "TLSv1" as const, ciphers: "DEFAULT@SECLEVEL=0" } : {})
  };
  const readHandshake = (socket: TLSSocket) => ({
    protocol: socket.getProtocol(),
    cipher: socket.getCipher(),
    authorized: socket.authorized,
    authorizationError: socket.authorizationError as unknown,
    certificate: socket.getPeerCertificate(true) as unknown
  });

  // One retry, because this is the probe worth retrying. Sites with a broken
  // certificate are usually neglected in other ways too - slow, overloaded,
  // half-maintained - and losing the handshake to a single slow response would
  // drop exactly the finding the visitor came for. The cost is bounded: one
  // extra socket, only ever after a failure, and the deprecated-protocol
  // probes below never run unless one of these succeeded.
  let handshake = await inspectTlsSocket(connectOptions, TLS_TIMEOUT_MS, readHandshake);
  if (!handshake.ok) {
    handshake = await inspectTlsSocket(connectOptions, TLS_TIMEOUT_MS, readHandshake);
  }
  if (!handshake.ok) return null;

  const { protocol, cipher, authorized, authorizationError, certificate } = handshake.value;
  const subject = (certificate as { subject?: unknown } | null)?.subject ?? null;
  const issuer = (certificate as { issuer?: unknown } | null)?.issuer ?? null;

  const subjectCn = certField(subject, "CN");
  const validFrom = toIsoDate(certField(certificate, "valid_from"));
  const validTo = toIsoDate(certField(certificate, "valid_to"));
  const subjectAltNames = parseSubjectAltNames(certField(certificate, "subjectaltname"));
  const authError = describeAuthorizationError(authorizationError);

  const daysUntilExpiry =
    validTo === null
      ? null
      : Math.floor((Date.parse(validTo) - Date.now()) / (24 * 60 * 60 * 1000));

  const names = subjectCn ? [subjectCn, ...subjectAltNames] : subjectAltNames;
  const hostnameMatches = names.some((name) => certNameMatches(host, name));

  const subjectName = canonicalName(subject);
  const isSelfSigned =
    (subjectName.length > 0 && subjectName === canonicalName(issuer)) ||
    (authError !== null && SELF_SIGNED_ERRORS.has(authError));

  // Only bother with the deprecated-protocol probes once we know the host
  // completes a handshake at all - two more sockets against a dead port is
  // just noise. They run in parallel and each fails soft to `null`.
  const [tls10, tls11] = await Promise.all([
    probeLegacyProtocol(guard.url, "TLSv1").catch(() => null),
    probeLegacyProtocol(guard.url, "TLSv1.1").catch(() => null)
  ]);

  return {
    protocol: protocol ?? null,
    cipher: cipher ? { name: cipher.name, version: cipher.version } : null,
    authorized,
    authorizationError: authError,
    subjectCn,
    issuer: certField(issuer, "O") ?? certField(issuer, "CN"),
    validFrom,
    validTo,
    daysUntilExpiry,
    subjectAltNames,
    keyBits: certNumber(certificate, "bits"),
    // Node never actually populates `sigalg`, so in practice this reports the
    // key algorithm: the curve name for EC certificates, and "RSA" inferred
    // from the presence of a modulus otherwise. Reading the true signature OID
    // would mean parsing the DER ourselves, which is not worth an ASN.1 parser.
    signatureAlgorithm:
      certField(certificate, "sigalg") ??
      certField(certificate, "asn1Curve") ??
      certField(certificate, "nistCurve") ??
      (certField(certificate, "modulus") ? "RSA" : null),
    isSelfSigned,
    hostnameMatches,
    legacyProtocols: { tls10, tls11 }
  };
}

/* -------------------------------------------------------------------------- */
/* Exposed paths                                                               */
/* -------------------------------------------------------------------------- */

interface ExposedPathTarget {
  path: string;
  label: string;
  risk: ExposedPathProbe["risk"];
  /**
   * Positive content signature. A 2xx is worth nothing on its own - this is
   * what decides whether the bytes really are the file we asked for.
   */
  looksReal: (probe: ProbeResult) => boolean;
  /** Set only where an HTML response can legitimately be the real answer. */
  allowHtml?: boolean;
  /**
   * Set where a hit is a configuration signal rather than leaked content, so
   * quoting the body back would be noise instead of evidence.
   */
  noExcerpt?: boolean;
}

/** Line-oriented `KEY=VALUE`, which is all a dotenv file ever is. */
function looksLikeEnvFile(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (lines.length === 0) return false;
  const assignments = lines.filter((line) =>
    /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*=/.test(line)
  );
  // Most lines being assignments rules out prose that happens to contain "=".
  return assignments.length > 0 && assignments.length >= Math.ceil(lines.length * 0.6);
}

function parsesAsJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

const EXPOSED_PATH_TARGETS: ExposedPathTarget[] = [
  {
    path: "/.env",
    label: "Environment file",
    risk: "critical",
    looksReal: (probe) => looksLikeEnvFile(probe.text)
  },
  {
    path: "/.env.local",
    label: "Local environment file",
    risk: "critical",
    looksReal: (probe) => looksLikeEnvFile(probe.text)
  },
  {
    path: "/.env.production",
    label: "Production environment file",
    risk: "critical",
    looksReal: (probe) => looksLikeEnvFile(probe.text)
  },
  {
    path: "/.git/config",
    label: "Git repository config",
    risk: "critical",
    looksReal: (probe) => /\[core\]/i.test(probe.text) || /\[remote\s+"/i.test(probe.text)
  },
  {
    path: "/.git/HEAD",
    label: "Git HEAD",
    risk: "critical",
    looksReal: (probe) => /^ref:\s*refs\//m.test(probe.text.trimStart())
  },
  {
    path: "/.aws/credentials",
    label: "AWS credentials",
    risk: "critical",
    looksReal: (probe) => /aws_access_key_id/i.test(probe.text)
  },
  {
    path: "/id_rsa",
    label: "Private SSH key",
    risk: "critical",
    looksReal: (probe) => /PRIVATE KEY/.test(probe.text)
  },
  {
    path: "/.npmrc",
    label: "npm credentials file",
    risk: "critical",
    looksReal: (probe) =>
      probe.text.includes("=") && /(^|\n)\s*(?:\/\/[^\n]*:)?_authToken\s*=|registry\s*=/i.test(probe.text)
  },
  {
    path: "/wp-config.php.bak",
    label: "WordPress config backup",
    risk: "critical",
    looksReal: (probe) => /DB_(?:NAME|USER|PASSWORD|HOST)|<\?php/i.test(probe.text)
  },
  {
    path: "/.svn/entries",
    label: "Subversion metadata",
    risk: "warning",
    looksReal: (probe) => {
      const head = probe.text.trimStart();
      return /^\d+\s/.test(head) || /^\d+$/m.test(head.split(/\r?\n/)[0] ?? "") || head.startsWith("<?xml");
    }
  },
  {
    path: "/docker-compose.yml",
    label: "Docker Compose file",
    risk: "warning",
    looksReal: (probe) => /^\s*(?:services|version)\s*:/m.test(probe.text)
  },
  {
    path: "/Dockerfile",
    label: "Dockerfile",
    risk: "warning",
    looksReal: (probe) => /^\s*FROM\s+\S+/im.test(probe.text)
  },
  {
    path: "/.htaccess",
    label: "Apache access config",
    risk: "warning",
    looksReal: (probe) =>
      /^\s*(?:RewriteEngine|RewriteRule|Order\s|Deny\s+from|Allow\s+from|AddType|<IfModule)/im.test(
        probe.text
      )
  },
  {
    path: "/web.config",
    label: "IIS configuration",
    risk: "warning",
    looksReal: (probe) => /<configuration[\s>]/i.test(probe.text)
  },
  {
    path: "/phpinfo.php",
    label: "phpinfo() output",
    risk: "warning",
    // The one place an HTML body is the genuine artefact rather than a shell.
    allowHtml: true,
    looksReal: (probe) => /PHP Version|phpinfo\(\)/i.test(probe.text)
  },
  {
    path: "/server-status",
    label: "Apache server-status",
    risk: "warning",
    allowHtml: true,
    looksReal: (probe) => /Apache Server Status/i.test(probe.text)
  },
  {
    path: "/.DS_Store",
    label: "macOS directory index",
    risk: "warning",
    // Binary format: four null-ish bytes then the "Bud1" magic.
    looksReal: (probe) =>
      probe.bytes.byteLength >= 8 &&
      Buffer.from(probe.bytes.subarray(0, 16)).toString("latin1").includes("Bud1")
  },
  {
    path: "/backup.sql",
    label: "SQL backup",
    risk: "warning",
    looksReal: (probe) => /CREATE TABLE|INSERT INTO|DROP TABLE/i.test(probe.text)
  },
  {
    path: "/database.sql",
    label: "SQL dump",
    risk: "warning",
    looksReal: (probe) => /CREATE TABLE|INSERT INTO|DROP TABLE/i.test(probe.text)
  },
  {
    path: "/package.json",
    label: "npm manifest",
    risk: "info",
    looksReal: (probe) => {
      const parsed = parsesAsJsonObject(probe.text);
      return parsed !== null && ("name" in parsed || "version" in parsed);
    }
  },
  {
    path: "/composer.json",
    label: "Composer manifest",
    risk: "info",
    looksReal: (probe) => {
      const parsed = parsesAsJsonObject(probe.text);
      return parsed !== null && ("require" in parsed || "autoload" in parsed || "name" in parsed);
    }
  },
  {
    path: "/.well-known/change-password",
    label: "Change-password endpoint",
    risk: "info",
    allowHtml: true,
    // The body here is whatever password page we were sent to - a fact about
    // the site's routing, not a leak worth quoting.
    noExcerpt: true,
    // RFC 8615 says this should redirect to the real password page. A site that
    // simply serves its SPA shell here has not implemented it, so a redirect to
    // somewhere else is the only signal we accept as genuine.
    looksReal: (probe) => probe.redirected
  }
];

/**
 * Redacts anything secret-shaped out of an excerpt.
 *
 * The excerpt exists as evidence and is rendered straight into a report, which
 * may be shared, screenshotted or emailed. If we ever hand back a live
 * credential we have made the exposure strictly worse than we found it, so this
 * runs before storage and errs heavily towards over-redacting: values after any
 * `key=`, plus any long base64/hex-looking run wherever it appears.
 */
function redactSecrets(text: string): string {
  return text
    .replace(/([A-Za-z_][A-Za-z0-9_.\-]*\s*=\s*)("[^"\n]*"|'[^'\n]*'|[^\s]+)/g, "$1[redacted]")
    .replace(/[A-Za-z0-9+/_\-]{20,}={0,2}/g, "[redacted]");
}

function buildExcerpt(text: string): string | null {
  // Redact on the raw, line-structured text: collapsing whitespace first would
  // let a value run into the next key and escape the `key=value` pattern.
  const redacted = redactSecrets(text.slice(0, 800));
  // Binary artefacts (a .DS_Store, a stray archive) decode to control-character
  // soup that would render as garbage in a report.
  const printable = redacted.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
  const collapsed = printable.replace(/\s+/g, " ").trim();
  return collapsed ? collapsed.slice(0, EXCERPT_LENGTH) : null;
}

/**
 * Is this response just the site's catch-all?
 *
 * Soft-404 discrimination is the entire game for exposure probing: most modern
 * hosts answer *every* unknown path with a 200 and an SPA shell, so a naive
 * "status is 200 therefore /.env is exposed" reports a critical finding on
 * roughly every React site on the internet. We compare against the body we
 * already fetched for the known-nonexistent probe path - byte-identical, or
 * near-identical in length with a matching prefix, means the server is handing
 * us the same page it hands everyone.
 */
function isCatchAllBody(text: string, notFoundBody: string | null): boolean {
  if (!notFoundBody) return false;
  if (text === notFoundBody) return true;
  if (text.length === 0 || notFoundBody.length === 0) return false;

  const longest = Math.max(text.length, notFoundBody.length);
  const delta = Math.abs(text.length - notFoundBody.length);
  if (delta / longest > 0.05) return false;

  // Length alone is far too weak, so an edge has to match as well. Either edge
  // will do: a catch-all that echoes the path it was asked for differs near the
  // top but is identical at the bottom, and vice versa.
  const edge = 120;
  return (
    text.slice(0, edge) === notFoundBody.slice(0, edge) ||
    text.slice(-edge) === notFoundBody.slice(-edge)
  );
}

/**
 * The record for a path we asked about but got no answer for. Status 0 says
 * plainly "attempted, no response", which a check can distinguish from a clean
 * 404 - "we looked" is information either way.
 */
function unattemptedProbe(target: ExposedPathTarget, origin: string): ExposedPathProbe {
  return {
    path: target.path,
    url: `${origin}${target.path}`,
    status: 0,
    contentType: null,
    bytes: 0,
    exposed: false,
    excerpt: null,
    label: target.label,
    risk: target.risk
  };
}

async function probeExposedPaths(
  session: ReconSession,
  origin: string,
  notFoundBody: string | null,
  sink: ExposedPathProbe[]
): Promise<ExposedPathProbe[]> {
  return mapWithLimit(
    EXPOSED_PATH_TARGETS,
    RECON_CONCURRENCY,
    async (target) => {
      const probe = await reconGet(session, `${origin}${target.path}`, {
        limit: MAX_PROBE_BYTES
      });
      if (!probe) return unattemptedProbe(target, origin);

      const twoXx = probe.status >= 200 && probe.status < 300;
      const html = isHtmlResponse(probe);
      const exposed =
        twoXx &&
        !(html && target.allowHtml !== true) &&
        !isCatchAllBody(probe.text, notFoundBody) &&
        target.looksReal(probe);

      return {
        path: target.path,
        url: probe.url,
        status: probe.status,
        contentType: probe.contentType,
        // The read cap, not the file's real size: a 40 MB dump reports 65536.
        bytes: probe.length,
        exposed,
        // Keep evidence only for real hits; an excerpt of someone's marketing
        // page is noise, and storing less is always the safer default.
        excerpt: exposed && target.noExcerpt !== true ? buildExcerpt(probe.text) : null,
        label: target.label,
        risk: target.risk
      } satisfies ExposedPathProbe;
    },
    sink
  );
}

/* -------------------------------------------------------------------------- */
/* security.txt                                                                */
/* -------------------------------------------------------------------------- */

/**
 * RFC 9116 puts the file at `/.well-known/security.txt` and keeps the legacy
 * root location as a fallback. Same discrimination problem as everything else:
 * a genuine file declares at least one `Contact:` field, an SPA shell does not.
 */
async function probeSecurityTxt(
  session: ReconSession,
  origin: string
): Promise<TextResource | null> {
  const candidates = [`${origin}/.well-known/security.txt`, `${origin}/security.txt`];
  let fallback: TextResource | null = null;

  for (const url of candidates) {
    const probe = await reconGet(session, url, { limit: MAX_PROBE_BYTES, accept: TEXT_ACCEPT });
    if (!probe) continue;

    const genuine =
      probe.status >= 200 &&
      probe.status < 300 &&
      !isHtmlResponse(probe) &&
      /^\s*Contact\s*:/im.test(probe.text);

    const resource: TextResource = {
      url: probe.url,
      ok: genuine,
      status: probe.status,
      contentType: probe.contentType,
      body: probe.text,
      bytes: probe.length
    };
    if (genuine) return resource;
    fallback ??= resource;
  }

  return fallback;
}

/* -------------------------------------------------------------------------- */
/* DNS                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Multi-label public suffixes common enough to matter.
 *
 * A pragmatic heuristic, not a public-suffix list: pulling in the PSL would add
 * a dependency and a megabyte of data to answer "which label is registrable".
 * Getting this wrong means querying SPF at the wrong level, which the check
 * module reports honestly as "no record" - bad, but not dangerous.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk",
  "com.au",
  "co.nz",
  "co.jp",
  "com.br",
  "co.za",
  "org.uk",
  "net.au",
  "org.au",
  "ac.uk",
  "gov.uk"
]);

function registrableDomain(host: string): string {
  const labels = host
    .toLowerCase()
    .replace(/\.$/, "")
    .split(".")
    .filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".");
  return lastTwo;
}

/** NXDOMAIN for a record type is the normal case, not an error worth raising. */
async function resolveOrNull<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch {
    return null;
  }
}

function flattenTxt(records: string[][] | null): string[] {
  // A TXT record arrives as an array of 255-byte chunks that must be
  // concatenated before the policy inside it can be read.
  return (records ?? []).map((chunks) => chunks.join("").trim()).filter(Boolean);
}

const DKIM_SELECTORS = [
  "default",
  "google",
  "selector1",
  "selector2",
  "k1",
  "dkim",
  "mail",
  "s1"
];

/**
 * Reads the DNS records that decide whether someone can spoof this domain's
 * email, and which CAs may issue certificates for it.
 *
 * These are ordinary recursive lookups against the public DNS - no zone
 * transfers, no brute-forced subdomain enumeration. The SSRF guard does not
 * apply here because nothing connects to the answers; we only read them.
 */
async function probeDns(host: string): Promise<DnsRecords | null> {
  const domain = registrableDomain(host);
  if (!domain.includes(".")) return null;

  // Per-query timeout and a single try: a domain with a dead nameserver must
  // not hold the recon budget hostage.
  const resolver = new Resolver({ timeout: PROBE_TIMEOUT_MS, tries: 1 });

  // Email policy lives on the registrable domain, never on the www host.
  const [txt, dmarcTxt, mx, ns, caa] = await Promise.all([
    resolveOrNull(() => resolver.resolveTxt(domain)),
    resolveOrNull(() => resolver.resolveTxt(`_dmarc.${domain}`)),
    resolveOrNull(() => resolver.resolveMx(domain)),
    resolveOrNull(() => resolver.resolveNs(domain)),
    resolveOrNull(() => resolver.resolveCaa(domain))
  ]);

  const dkimResults = await mapWithLimit(DKIM_SELECTORS, DNS_CONCURRENCY, async (selector) => {
    const records = flattenTxt(
      await resolveOrNull(() => resolver.resolveTxt(`${selector}._domainkey.${domain}`))
    );
    // Two traps here. A wildcard TXT record answers for every selector we ask
    // about, and `p=` with an empty value is RFC 6376's explicit "this key is
    // revoked" - example.com publishes exactly that. Neither is a working
    // selector, so a real public key is required before we count it.
    const found = records.some(
      (record) =>
        /(?:^|;)\s*(?:v=DKIM1|k=)/i.test(record) &&
        /(?:^|;)\s*p\s*=\s*[A-Za-z0-9+/]{10,}/i.test(record)
    );
    return found ? selector : null;
  });

  // Kept whole as well as filtered: `spf` below can only hold one record, so a
  // domain publishing two `v=spf1` lines - a permerror that silently voids SPF
  // altogether - would be invisible without the raw list.
  const apexTxt = flattenTxt(txt);

  const caaStrings: string[] = [];
  for (const record of caa ?? []) {
    for (const tag of ["issue", "issuewild", "iodef", "contactemail", "contactphone"] as const) {
      const value = record[tag];
      if (typeof value === "string" && value) {
        caaStrings.push(`${record.critical} ${tag} "${value}"`);
      }
    }
  }

  return {
    host,
    domain,
    spf: apexTxt.find((record) => /^v=spf1\b/i.test(record)) ?? null,
    dmarc: flattenTxt(dmarcTxt).find((record) => /^v=DMARC1\b/i.test(record)) ?? null,
    txt: apexTxt,
    dkimTested: [...DKIM_SELECTORS],
    dkimFound: dkimResults.filter((selector): selector is string => selector !== null),
    caa: caaStrings,
    mx: (mx ?? [])
      .slice()
      .sort((a, b) => a.priority - b.priority)
      // Node reports RFC 7505's null MX ("0 .") with an empty exchange; keep
      // the root label so "this domain deliberately accepts no mail" survives.
      .map((record) => `${record.priority} ${record.exchange || "."}`),
    ns: (ns ?? []).slice().sort(),
    // Node's resolver never surfaces the AD bit, and inventing a value here
    // would be worse than admitting we cannot see it. `RdapInfo.dnssecSigned`
    // is where the answer actually comes from - the registry knows whether the
    // delegation is signed, and says so.
    dnssec: null
  };
}

/* -------------------------------------------------------------------------- */
/* RDAP                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Registration facts, read straight from the registry.
 *
 * RDAP rather than port-43 WHOIS because WHOIS is free-form text in a different
 * shape per registry, each of which would need its own parser; RDAP is JSON over
 * HTTPS with a schema (RFC 9083). The field that would justify the request on its
 * own is `secureDNS.delegationSigned` - a stub resolver cannot see whether a zone
 * is signed, so without RDAP the report has to call DNSSEC "not evaluated".
 *
 * `rdap.org` is a bootstrap redirector: it 302s to the authoritative registry
 * server for the TLD, so one request covers every TLD rather than this file
 * carrying a per-registry endpoint table it would have to keep current.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/* --- narrowing helpers: RDAP is someone else's JSON, so nothing is asserted --- */

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * jCard (RFC 7095) is vCard transliterated into JSON, and it shows: a registrar
 * name arrives as `["vcard", [["fn", {}, "text", "GoDaddy.com, LLC"]]]` -
 * positional arrays, untyped, with the value four elements in and the property
 * name carrying no guarantee of case.
 */
function jCardProperty(vcardArray: unknown, name: string): unknown {
  if (!Array.isArray(vcardArray) || vcardArray.length < 2) return null;
  const properties = vcardArray[1];
  if (!Array.isArray(properties)) return null;

  for (const property of properties) {
    // [name, parameters, type, value]
    if (!Array.isArray(property) || property.length < 4) continue;
    const key = property[0];
    if (typeof key === "string" && key.toLowerCase() === name) return property[3];
  }
  return null;
}

function jCardText(vcardArray: unknown, name: string): string | null {
  return asText(jCardProperty(vcardArray, name));
}

/**
 * `adr` carries the seven positional vCard address components, of which the
 * country is the last. Registries that redact an address blank the earlier
 * slots and keep the country, so the tail is the only part worth reading.
 */
function jCardCountry(vcardArray: unknown): string | null {
  const value = jCardProperty(vcardArray, "adr");
  if (!Array.isArray(value) || value.length === 0) return null;
  return asText(value[value.length - 1]);
}

/**
 * RFC 9083 spells statuses and event actions as lowercase words ("client
 * transfer prohibited"), but a registry is free to echo the raw EPP camelCase
 * ("clientTransferProhibited") instead. Splitting the humps lands both spellings
 * on the space-separated lowercase form, which is what `RdapInfo.statuses`
 * promises and the only form a check should ever have to match.
 */
function normaliseRdapToken(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Guards against the event simply not being there, which is the common case. */
function rdapEventDate(events: unknown, action: string): string | null {
  for (const entry of asArray(events)) {
    const event = asRecord(entry);
    if (!event) continue;
    const eventAction = asText(event.eventAction);
    if (!eventAction || normaliseRdapToken(eventAction) !== action) continue;
    // Registries emit ISO 8601 already, but routing it through `Date` keeps the
    // field uniform with the certificate dates and drops anything unparseable.
    const iso = toIsoDate(asText(event.eventDate));
    if (iso) return iso;
  }
  return null;
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? Math.floor((parsed - Date.now()) / DAY_MS) : null;
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? Math.floor((Date.now() - parsed) / DAY_MS) : null;
}

function findRdapEntity(entities: unknown, role: string): Record<string, unknown> | null {
  for (const entry of asArray(entities)) {
    const entity = asRecord(entry);
    if (!entity) continue;
    const hasRole = asArray(entity.roles).some(
      (value) => typeof value === "string" && value.toLowerCase() === role
    );
    if (hasRole) return entity;
  }
  return null;
}

function rdapPublicId(entity: Record<string, unknown> | null, type: string): string | null {
  if (!entity) return null;
  for (const entry of asArray(entity.publicIds)) {
    const id = asRecord(entry);
    if (!id) continue;
    if (asText(id.type)?.toLowerCase() !== type) continue;
    // Registries disagree about whether the identifier is quoted.
    if (typeof id.identifier === "number") return String(id.identifier);
    const identifier = asText(id.identifier);
    if (identifier) return identifier;
  }
  return null;
}

/**
 * Names the large privacy-proxy services put on the registrant record. A domain
 * behind one of these is registered by someone; the registry is simply not
 * saying who.
 */
const PRIVACY_PROXY_RE =
  /domains by proxy|privacy protect|withheld for privacy|redacted|data protected/i;

/** RDAP's own way of saying "this contact has been stripped". */
function isRedactedEntity(entity: Record<string, unknown>): boolean {
  for (const entry of asArray(entity.remarks)) {
    const remark = asRecord(entry);
    if (!remark) continue;
    const title = asText(remark.title)?.toLowerCase() ?? "";
    const type = asText(remark.type)?.toLowerCase() ?? "";
    // Nominet ships both "REDACTED FOR PRIVACY" and "EMAIL REDACTED FOR
    // PRIVACY", hence the substring rather than an equality test.
    if (title.includes("redacted for privacy")) return true;
    if (type === "object redacted due to authorization") return true;
  }
  return false;
}

function mapRdapResponse(data: Record<string, unknown>, source: string): RdapInfo {
  const registrarEntity = findRdapEntity(data.entities, "registrar");
  const registrantEntity = findRdapEntity(data.entities, "registrant");
  // Abuse contacts hang off the registrar, not the domain - the registry has no
  // opinion about who handles complaints, the registrar does.
  const abuseEntity = registrarEntity ? findRdapEntity(registrarEntity.entities, "abuse") : null;

  const registrantName = registrantEntity ? jCardText(registrantEntity.vcardArray, "fn") : null;

  /*
   * Post-GDPR the usual answer is that there is no registrant object at all:
   * gTLD registries strip the contact wholesale, so an absent entity is
   * redaction rather than an unknown. A present entity only counts as "not
   * protected" when it actually names someone. Present-but-nameless with nothing
   * saying why stays null, because "this registry publishes no contacts" and
   * "this registrant is hidden" are different claims we cannot tell apart.
   */
  let privacyProtected: boolean | null;
  if (!registrantEntity) privacyProtected = true;
  else if (isRedactedEntity(registrantEntity)) privacyProtected = true;
  else if (registrantName) privacyProtected = PRIVACY_PROXY_RE.test(registrantName);
  else privacyProtected = null;

  const registered = rdapEventDate(data.events, "registration");
  const expires = rdapEventDate(data.events, "expiration");
  const delegationSigned = asRecord(data.secureDNS)?.delegationSigned;

  return {
    source,
    handle: asText(data.handle),
    registrar: registrarEntity ? jCardText(registrarEntity.vcardArray, "fn") : null,
    registrarIanaId: rdapPublicId(registrarEntity, "iana registrar id"),
    statuses: asArray(data.status)
      .filter((value): value is string => typeof value === "string")
      .map(normaliseRdapToken)
      .filter(Boolean),
    registered,
    expires,
    lastChanged: rdapEventDate(data.events, "last changed"),
    daysUntilExpiry: daysUntil(expires),
    ageDays: daysSince(registered),
    // Absent is not false. "The registry did not say" and "the delegation is
    // unsigned" are different facts, and collapsing the first into the second
    // would have a check report a DNSSEC failure nobody ever claimed.
    dnssecSigned: typeof delegationSigned === "boolean" ? delegationSigned : null,
    nameservers: asArray(data.nameservers)
      .map((entry) => asText(asRecord(entry)?.ldhName))
      .filter((name): name is string => name !== null)
      /*
       * Normalised to a bare hostname so a check can line these up against the
       * live NS records without tripping over punctuation. Nominet returns
       * "dns0.bbc.co.uk." with the root label, Verisign shouts in upper case,
       * and the .fi registry appends a validation marker - "ns-fi.elisa.net
       * [OK]" - inside a field whose name promises letters, digits and hyphens
       * only. Take the first token, lower it, drop the trailing dot, and
       * discard anything that still is not host-shaped.
       */
      .map((name) => name.split(/\s+/)[0].toLowerCase().replace(/\.$/, ""))
      .filter((name) => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name)),
    privacyProtected,
    registrantName,
    registrantCountry: registrantEntity ? jCardCountry(registrantEntity.vcardArray) : null,
    abuseEmail: abuseEntity ? jCardText(abuseEntity.vcardArray, "email") : null
  };
}

/** One guarded request to the bootstrap redirector. Every failure is `null`. */
async function probeRdap(host: string): Promise<RdapInfo | null> {
  // An IP literal has no registration to look up.
  if (isIP(host) !== 0) return null;

  // Same public-suffix heuristic the DNS probe uses, and for the same reason:
  // registration data lives on the registrable domain, and asking a registry
  // about `www.example.com` earns a 404 from every one of them.
  const domain = registrableDomain(host);
  if (!domain.includes(".")) return null;

  const deadline = createDeadline(RDAP_TIMEOUT_MS);
  try {
    // `safeFetch` re-runs the SSRF guard on the bootstrap host *and* on the
    // registry it redirects us to. rdap.org is external and well known, but the
    // guard is unconditional - there is no allowlist to be on.
    const result = await safeFetch(`${RDAP_BOOTSTRAP}${encodeURIComponent(domain)}`, {
      deadline,
      maxRedirects: RDAP_MAX_REDIRECTS,
      accept: RDAP_ACCEPT
    });
    if (!result.ok) return null;

    // A 404 here is routine rather than an error: it is what a registry says
    // about a domain it does not serve, and what the redirector says about a TLD
    // with no RDAP service at all - .io, .co and .jp are still absent from the
    // IANA bootstrap registry.
    if (result.response.status !== 200) {
      await cancelBody(result.response);
      return null;
    }

    const read = await readCapped(result.response, MAX_RDAP_BYTES, deadline);
    if (read === "too-large") return null;

    // JSON is UTF-8 by definition (RFC 8259), whatever the charset parameter says.
    const data = parsesAsJsonObject(decodeBytes(read.bytes, "utf-8"));
    if (!data) return null;

    // The URL that answered, not the one we asked - the bootstrap hop is an
    // implementation detail, the registry endpoint is the citation.
    return mapRdapResponse(data, result.finalUrl);
  } catch {
    return null;
  } finally {
    deadline.dispose();
  }
}

/* -------------------------------------------------------------------------- */
/* HTTP methods                                                                */
/* -------------------------------------------------------------------------- */

const TRACE_ECHO_HEADER = "x-devforge-audit";
const TRACE_ECHO_TOKEN = "trace-reflection-probe";

function parseAllowHeader(value: string | null): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  for (const token of value.split(",")) {
    const method = token.trim().toUpperCase();
    if (method && /^[A-Z-]{3,20}$/.test(method)) seen.add(method);
  }
  return [...seen];
}

/**
 * One TRACE request, checking whether the server echoes our headers back.
 *
 * This has to bypass `fetch`: TRACE is a "forbidden method" in the WHATWG fetch
 * spec, so undici throws a TypeError before a packet leaves. `node:https` will
 * send it. The request is still guarded, still single-shot, still read-only -
 * TRACE is defined as a safe method whose entire job is to reflect the request.
 */
async function probeTrace(target: URL, insecure: boolean): Promise<boolean> {
  const guard = await assertPublicHttpUrl(target.href);
  if (!guard.ok) return false;

  const secure = guard.url.protocol === "https:";
  const options: RequestOptions = {
    protocol: guard.url.protocol,
    hostname: guard.url.hostname,
    port: guard.url.port || (secure ? 443 : 80),
    path: `${guard.url.pathname}${guard.url.search}`,
    method: "TRACE",
    headers: {
      "user-agent": USER_AGENT,
      accept: ANY_ACCEPT,
      [TRACE_ECHO_HEADER]: TRACE_ECHO_TOKEN
    },
    timeout: PROBE_TIMEOUT_MS,
    // Matches the transport the rest of this audit is already using; never set
    // unless the document fetch already had to fall back.
    ...(insecure ? { rejectUnauthorized: false } : {})
  };

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        request.destroy();
      } catch {
        // Already closed.
      }
      resolve(value);
    };

    const request = (secure ? httpsRequest : httpRequest)(options, (response) => {
      const status = response.statusCode ?? 0;
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        // A few KB is far more than enough to spot the reflection.
        if (body.length < 8192) body += chunk;
      });
      response.on("end", () =>
        // Reflected only counts when the server both accepted TRACE and gave us
        // our own header back - a 200 alone could be any handler.
        finish(status === 200 && body.includes(TRACE_ECHO_TOKEN))
      );
      response.on("error", () => finish(false));
    });

    request.on("timeout", () => finish(false));
    request.on("error", () => finish(false));
    request.end();
  });
}

async function probeHttpMethods(
  session: ReconSession,
  target: URL
): Promise<HttpMethodsProbe | null> {
  // Both tasks resolve to a wrapper object rather than a bare value, so a
  // `null` from `session.run` can only mean "the budget ran out before this
  // was attempted" - which is the one case that deserves a null probe instead
  // of a probe reporting absence.
  const allow = await session.run(async () => {
    const deadline = createDeadline(PROBE_TIMEOUT_MS);
    try {
      const result = await safeFetch(target.href, {
        deadline,
        maxRedirects: 0,
        method: "OPTIONS",
        accept: ANY_ACCEPT,
        stopAtRedirect: true,
        insecure: session.insecure
      });
      if (!result.ok) return { header: null };
      const headers = result.response.headers;
      await cancelBody(result.response);
      // CORS preflight responses answer with the CORS header instead; either
      // one is the server telling us what it will accept.
      return { header: headers.get("allow") ?? headers.get("access-control-allow-methods") };
    } catch {
      return { header: null };
    } finally {
      deadline.dispose();
    }
  });

  // TRACE is attempted regardless: OPTIONS failing says nothing about it.
  const trace = await session
    .run(async () => ({ reflected: await probeTrace(target, session.insecure) }))
    .catch(() => ({ reflected: false }));

  if (!allow && !trace) return null;

  const allowHeader = allow?.header ?? null;
  return {
    allowHeader,
    methods: parseAllowHeader(allowHeader),
    traceEnabled: trace?.reflected ?? false
  };
}

/* -------------------------------------------------------------------------- */
/* Source maps                                                                 */
/* -------------------------------------------------------------------------- */

const SOURCE_MAPPING_RE = /[#@]\s*sourceMappingURL\s*=\s*([^\s'"*]+)/g;

/** Last one wins: the trailing comment is the one the tooling emitted. */
function findSourceMappingUrl(script: string): string | null {
  SOURCE_MAPPING_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = SOURCE_MAPPING_RE.exec(script)) !== null) last = match[1];
  return last;
}

function decodeInlineSourceMap(uri: string): string | null {
  const match = /^data:([^,]*),([\s\S]*)$/.exec(uri);
  if (!match) return null;
  try {
    return match[1].toLowerCase().includes(";base64")
      ? Buffer.from(match[2], "base64").toString("utf8")
      : decodeURIComponent(match[2]);
  } catch {
    return null;
  }
}

interface SourceMapContents {
  valid: boolean;
  hasSourcesContent: boolean;
  sources: string[];
}

const INVALID_SOURCE_MAP: SourceMapContents = {
  valid: false,
  hasSourcesContent: false,
  sources: []
};

function readSourceMap(json: string): SourceMapContents {
  const parsed = parsesAsJsonObject(json);
  // `version` is mandatory in the source map spec, so its absence is the
  // cheapest way to reject an HTML error page that happened to parse.
  if (!parsed || parsed.version === undefined) return INVALID_SOURCE_MAP;

  const sources = Array.isArray(parsed.sources)
    ? parsed.sources.filter((entry): entry is string => typeof entry === "string")
    : [];
  const contents = Array.isArray(parsed.sourcesContent)
    ? parsed.sourcesContent.filter((entry) => typeof entry === "string" && entry.length > 0)
    : [];

  return {
    valid: true,
    hasSourcesContent: contents.length > 0,
    sources: sources.slice(0, MAX_SOURCE_MAP_SOURCES)
  };
}

/**
 * Salvage for a map that was cut off by the read cap.
 *
 * Multi-megabyte maps are routine, and a truncated body cannot be parsed as
 * JSON - so bailing out would hide the exposure on precisely the sites with the
 * biggest bundles. Instead we identify it structurally: a JSON object that
 * declares `version` up front and carries the payload keys somewhere after.
 *
 * Only `version` is looked for in the head, because key order is entirely up to
 * the bundler - webpack puts the multi-megabyte `mappings` string second and
 * `sources` well past any fixed head window. Whatever lands beyond the cap is
 * simply not reported; `accessible` is the finding that matters here.
 */
function readTruncatedSourceMap(text: string): SourceMapContents {
  const head = text.slice(0, 4096);
  if (!/^\s*\{/.test(head) || !/"version"\s*:/.test(head)) return INVALID_SOURCE_MAP;
  if (!/"sources"\s*:/.test(text) && !/"mappings"\s*:/.test(text)) return INVALID_SOURCE_MAP;

  const sources: string[] = [];
  const list = /"sources"\s*:\s*\[([\s\S]*?)\]/.exec(text);
  if (list) {
    for (const entry of list[1].matchAll(/"(?:[^"\\]|\\.)*"/g)) {
      try {
        sources.push(JSON.parse(entry[0]) as string);
      } catch {
        continue;
      }
      if (sources.length >= MAX_SOURCE_MAP_SOURCES) break;
    }
  }

  return {
    valid: true,
    hasSourcesContent: /"sourcesContent"\s*:\s*\[\s*"/.test(text),
    sources
  };
}

/** Reads one bundle, finds its map, and reports what that map gives away. */
async function probeOneSourceMap(
  session: ReconSession,
  scriptUrl: string
): Promise<SourceMapProbe | null> {
  const script = await reconGet(session, scriptUrl, {
    limit: MAX_SCRIPT_BYTES,
    accept: "application/javascript,text/javascript,*/*;q=0.8"
  });
  if (!script || script.status < 200 || script.status >= 300) return null;

  const declared = findSourceMappingUrl(script.text);

  // An inline map ships inside the bundle itself: no second request to make,
  // and its sources are unambiguously public already.
  if (declared && declared.startsWith("data:")) {
    const decoded = decodeInlineSourceMap(declared);
    const contents = decoded ? readSourceMap(decoded) : INVALID_SOURCE_MAP;
    return {
      scriptUrl,
      // Truncated: the whole point of an inline map is that it is enormous.
      mapUrl: `${declared.slice(0, 64)}…`,
      accessible: contents.valid,
      hasSourcesContent: contents.hasSourcesContent,
      sources: contents.sources
    };
  }

  let mapUrl: string;
  try {
    // No comment is not proof of absence - build tools routinely strip the
    // comment while still deploying the map right next to the bundle.
    const base = new URL(script.url);
    mapUrl = declared ? new URL(declared, base).href : `${base.origin}${base.pathname}.map`;
  } catch {
    return null;
  }

  const map = await reconGet(session, mapUrl, {
    limit: MAX_SOURCE_MAP_BYTES,
    accept: "application/json,*/*;q=0.8"
  });
  // Record the miss too: "we followed your bundle and found nothing" is the
  // reassuring half of this check.
  if (!map) return { scriptUrl, mapUrl, accessible: false, hasSourcesContent: false, sources: [] };

  const readable = map.status >= 200 && map.status < 300 && !isHtmlResponse(map);
  let contents = readable ? readSourceMap(map.text) : INVALID_SOURCE_MAP;
  if (!contents.valid && readable && map.truncated) contents = readTruncatedSourceMap(map.text);

  return {
    scriptUrl,
    mapUrl: map.url,
    accessible: contents.valid,
    hasSourcesContent: contents.hasSourcesContent,
    sources: contents.sources
  };
}

/**
 * Follows the site's own bundles to their source maps.
 *
 * This is the check that tells someone their original TypeScript - comments,
 * internal paths, occasionally an API key that only ever lived in a `.ts` file
 * - is downloadable by anyone. We read only what the page already links to.
 */
async function probeSourceMaps(
  session: ReconSession,
  origin: string,
  scripts: ParsedDocument["scripts"],
  sink: SourceMapProbe[]
): Promise<SourceMapProbe[]> {
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const script of scripts) {
    if (!script.src) continue;
    let parsed: URL;
    try {
      parsed = new URL(script.src);
    } catch {
      continue;
    }
    // Third-party bundles are not the site owner's to fix, and probing them
    // would be reconnaissance against a host the user never asked about.
    if (parsed.origin !== origin) continue;
    if (seen.has(parsed.href)) continue;
    seen.add(parsed.href);
    candidates.push(parsed.href);
    if (candidates.length >= MAX_SOURCE_MAP_SCRIPTS) break;
  }

  // There is nothing sensible to pre-fill this sink with - the map URL is
  // unknown until the bundle has been read - so each probe publishes itself as
  // it lands and the caller keeps whatever finished before the budget ran out.
  await mapWithLimit(candidates, RECON_CONCURRENCY, async (scriptUrl) => {
    const probe = await probeOneSourceMap(session, scriptUrl);
    if (probe) sink.push(probe);
    return probe;
  });

  return sink;
}

/* -------------------------------------------------------------------------- */
/* Directory listings                                                          */
/* -------------------------------------------------------------------------- */

const DIRECTORY_PATHS = ["/assets/", "/images/", "/uploads/", "/static/", "/files/"];

/** Fingerprints of the stock Apache, nginx and Python autoindex pages. */
const AUTOINDEX_MARKERS = [
  /<title>\s*Index of \//i,
  /<h1>\s*Index of \//i,
  /Directory listing for/i,
  /<a href="\?C=[NMSD];O=[AD]">/i,
  /<a href="\.\.\/">\.\.\/?<\/a>/i
];

async function probeDirectoryListings(
  session: ReconSession,
  origin: string,
  sink: { url: string; found: boolean }[]
): Promise<{ url: string; found: boolean }[]> {
  return mapWithLimit(
    DIRECTORY_PATHS,
    RECON_CONCURRENCY,
    async (path) => {
      const url = `${origin}${path}`;
      const probe = await reconGet(session, url, { limit: MAX_PROBE_BYTES, accept: HTML_ACCEPT });
      if (!probe) return { url, found: false };

      const twoXx = probe.status >= 200 && probe.status < 300;
      return {
        url: probe.url,
        found: twoXx && AUTOINDEX_MARKERS.some((marker) => marker.test(probe.text))
      };
    },
    sink
  );
}

/* -------------------------------------------------------------------------- */
/* Recon orchestration                                                         */
/* -------------------------------------------------------------------------- */

interface ReconResult {
  tls: TlsInfo | null;
  exposedPaths: ExposedPathProbe[];
  securityTxt: TextResource | null;
  dns: DnsRecords | null;
  rdap: RdapInfo | null;
  methods: HttpMethodsProbe | null;
  sourceMaps: SourceMapProbe[];
  directoryListing: { url: string; found: boolean }[];
}

/**
 * Runs every probe group in parallel behind one hard deadline.
 *
 * Results are written into a shared object as each group lands rather than
 * collected at the end, so blowing the budget costs us only the groups still in
 * flight - the certificate that resolved in 200 ms is still in the report. When
 * the budget expires the session is closed, which drops everything still queued
 * instead of letting it trickle out against a site we have finished with.
 */
async function runRecon(input: {
  finalUrl: URL;
  origin: string;
  scripts: ParsedDocument["scripts"];
  notFoundBody: string | null;
  insecure: boolean;
}): Promise<ReconResult> {
  // The list-shaped groups get their arrays up front and fill them in place, so
  // an expired budget costs us the probes still in flight rather than the whole
  // group. Every slot starts as an honest "attempted, no answer" record.
  const result: ReconResult = {
    tls: null,
    exposedPaths: EXPOSED_PATH_TARGETS.map((target) => unattemptedProbe(target, input.origin)),
    securityTxt: null,
    dns: null,
    rdap: null,
    methods: null,
    sourceMaps: [],
    directoryListing: DIRECTORY_PATHS.map((path) => ({
      url: `${input.origin}${path}`,
      found: false
    }))
  };

  const session = createReconSession(RECON_CONCURRENCY, MAX_RECON_REQUESTS, input.insecure);

  const tasks = [
    probeTls(input.finalUrl, input.insecure).then((value) => {
      result.tls = value;
    }),
    probeExposedPaths(session, input.origin, input.notFoundBody, result.exposedPaths),
    probeSecurityTxt(session, input.origin).then((value) => {
      result.securityTxt = value;
    }),
    probeDns(input.finalUrl.hostname).then((value) => {
      result.dns = value;
    }),
    // Deliberately outside the recon session, like the DNS and TLS probes: that
    // concurrency cap and request budget are a promise about how hard we lean on
    // the *target*, and this request goes to a registry instead. Running it here
    // rather than after the phase keeps it inside the same budget and off the
    // audit's critical path - it finishes long before the slowest target probe.
    probeRdap(input.finalUrl.hostname).then((value) => {
      result.rdap = value;
    }),
    probeHttpMethods(session, input.finalUrl).then((value) => {
      result.methods = value;
    }),
    probeSourceMaps(session, input.origin, input.scripts, result.sourceMaps),
    probeDirectoryListings(session, input.origin, result.directoryListing)
    // A rejection anywhere is already a fail-soft; `allSettled` below would
    // swallow it, but catching here keeps the shape uniform.
  ].map((task) => task.then(() => undefined).catch(() => undefined));

  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const budgetExpired = new Promise<void>((resolve) => {
    budgetTimer = setTimeout(resolve, RECON_BUDGET_MS);
  });

  try {
    await Promise.race([Promise.allSettled(tasks), budgetExpired]);
  } finally {
    clearTimeout(budgetTimer);
    session.close();
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* Certificate failures                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Transport errors that mean "the certificate is bad", not "the host is down".
 *
 * These are the failures worth retrying insecurely, because the site is plainly
 * there and answering - a report saying "your certificate expired in 2015" is
 * the single most useful thing this tool can tell that owner, and refusing to
 * connect is how the blind spot was created in the first place.
 */
const CERTIFICATE_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_ISSUER_CERT",
  "CERT_UNTRUSTED",
  "CERT_REVOKED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_INVALID_PROTOCOL_VERSION"
]);

function isCertificateFailure(failure: FetchFailure): boolean {
  if (failure.errorCode && CERTIFICATE_ERROR_CODES.has(failure.errorCode)) return true;
  // Node does not attach a code to every handshake rejection, so fall back to
  // the message. Deliberately narrow: only phrases that can *only* mean the
  // certificate, never a generic "socket hang up".
  return /certificate has expired|self-signed certificate|unable to verify the first certificate|certificate is not yet valid|does not match certificate|altname|unable to get local issuer/i.test(
    failure.message
  );
}

/**
 * Refusals that come from the TLS *configuration* rather than the certificate:
 * a server still stuck on TLS 1.0, a 480-bit Diffie-Hellman group, a cipher
 * suite retired years ago.
 *
 * These deserve the same treatment. The site is up and answering, a modern
 * client simply will not talk to it - which is itself the headline finding -
 * and the fallback transport already lowers the protocol floor and security
 * level precisely so the page can be retrieved and graded.
 */
const TLS_CONFIGURATION_ERROR_CODES = new Set([
  "ERR_SSL_UNSUPPORTED_PROTOCOL",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION",
  "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
  "ERR_SSL_DH_KEY_TOO_SMALL",
  "ERR_SSL_NO_PROTOCOLS_AVAILABLE",
  "ERR_SSL_NO_CIPHERS_AVAILABLE",
  "EPROTO"
]);

const TLS_CONFIGURATION_PATTERNS =
  /unsupported protocol|no protocols available|dh key too small|modulus too small|alert handshake failure|no ciphers available|version too low|inappropriate fallback|excessive message size/i;

function isTlsConfigurationFailure(failure: FetchFailure): boolean {
  if (failure.errorCode && TLS_CONFIGURATION_ERROR_CODES.has(failure.errorCode)) return true;
  return TLS_CONFIGURATION_PATTERNS.test(failure.message);
}

/** Both classes are worth exactly one insecure retry. */
function shouldRetryInsecurely(failure: FetchFailure): boolean {
  return isCertificateFailure(failure) || isTlsConfigurationFailure(failure);
}

/**
 * Plain English for the handshake refusals we understand.
 *
 * The raw string is an OpenSSL stack trace complete with a C source path and
 * line number, which tells a site owner nothing at all. Returning `null` here
 * means "no idea", and the caller keeps its own wording.
 */
function summariseTlsRefusal(failure: FetchFailure): string | null {
  const text = `${failure.errorCode ?? ""} ${failure.message}`;
  if (/unsupported protocol|no protocols available|protocol_version|version too low/i.test(text)) {
    return "it only offers an obsolete TLS version (TLS 1.1 or older) that browsers no longer accept";
  }
  if (/dh key too small|modulus too small/i.test(text)) {
    return "its Diffie-Hellman key is far too small to be considered secure";
  }
  if (/no ciphers available|alert handshake failure|null/i.test(text)) {
    return "it offers no cipher suite a modern client will accept";
  }
  if (/wrong version number/i.test(text)) {
    return "the port answered with something that is not TLS";
  }
  return null;
}

function formatCertificateDate(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/**
 * Turns a handshake rejection - certificate or configuration - into something a
 * site owner can act on.
 *
 * This string is the entire report when the audit cannot proceed, so it is
 * worth a second handshake to fill in the specifics - the probe connects with
 * validation disabled and can therefore read the certificate that `fetch` would
 * only throw about.
 */
async function describeTlsFailure(
  finalUrl: URL,
  failure: FetchFailure
): Promise<AuditFailure> {
  const host = finalUrl.hostname;

  // When the *configuration* is what refused us, lead with that. The
  // certificate may well be readable and perfectly valid, and reporting "your
  // certificate is fine" to someone whose server only speaks RC4 would send
  // them looking in entirely the wrong place.
  if (isTlsConfigurationFailure(failure)) {
    const summary = summariseTlsRefusal(failure);
    if (summary) {
      return fail(
        "network-error",
        `Could not establish a secure connection to ${host} - ${summary}. The site was not audited.`
      );
    }
  }

  // Relaxed, because the point is to read a certificate this client has already
  // refused once.
  const tls = await probeTls(finalUrl, true).catch(() => null);

  let detail: string | null = null;
  if (tls) {
    const expiry = formatCertificateDate(tls.validTo);
    const startsOn = formatCertificateDate(tls.validFrom);
    if (tls.daysUntilExpiry !== null && tls.daysUntilExpiry < 0 && expiry) {
      detail = `its certificate expired on ${expiry}`;
    } else if (tls.validFrom && Date.parse(tls.validFrom) > Date.now() && startsOn) {
      detail = `its certificate is not valid until ${startsOn}`;
    } else if (tls.isSelfSigned) {
      detail = "its certificate is self-signed, so no browser will trust it";
    } else if (!tls.hostnameMatches) {
      const covers = tls.subjectAltNames.slice(0, 3).join(", ") || tls.subjectCn;
      detail = covers
        ? `its certificate does not cover ${host} (it is issued for ${covers})`
        : `its certificate does not cover ${host}`;
    } else if (!tls.authorized) {
      detail = tls.authorizationError
        ? `its certificate chain could not be verified (${tls.authorizationError})`
        : "its certificate chain could not be verified";
    }
  }

  if (!detail) {
    // The handshake failed a second time, so say what we can from the error
    // itself rather than passing an OpenSSL stack trace to the user.
    detail = summariseTlsRefusal(failure) ?? "its TLS certificate could not be validated";
  }

  return fail(
    "network-error",
    `Could not establish a secure connection to ${host} - ${detail}. The site was not audited.`
  );
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

/** The document, decoded and validated, ready to be parsed and graded. */
interface FetchedDocument {
  html: string;
  finalUrl: string;
  finalStatus: number;
  redirects: RedirectHop[];
  headers: Record<string, string>;
  ttfbMs: number;
  totalMs: number;
  decodedBytes: number;
  bytes: number;
}

/**
 * Fetches and validates the audit target itself.
 *
 * Split out from `fetchPageContext` so it can be run twice: once normally, and
 * once more with certificate validation disabled when - and only when - the
 * first attempt failed *because* of the certificate.
 */
async function fetchDocument(
  requestedUrl: string,
  insecure: boolean
): Promise<{ ok: true; document: FetchedDocument } | FetchFailure> {
  const deadline = createDeadline(TOTAL_TIMEOUT_MS);

  try {
    const started = Date.now();
    const result = await safeFetch(requestedUrl, {
      deadline,
      maxRedirects: MAX_REDIRECTS,
      insecure
    });
    if (!result.ok) return result;

    const { response } = result;
    const contentType = response.headers.get("content-type") ?? "";
    const mime = contentType.split(";")[0].trim().toLowerCase();

    // Bail before reading the body when the type is unambiguously not a page -
    // no point streaming 4 MB of JPEG to discover it is not HTML.
    if (mime !== "" && !HTML_MIME_TYPES.has(mime)) {
      await cancelBody(response);
      if (response.status >= 400) {
        return fail(
          "http-error",
          `The site returned HTTP ${response.status} and the response was not HTML (${mime}).`,
          response.status
        );
      }
      return fail("not-html", `That URL returned "${mime}", not an HTML page.`);
    }

    const read = await readCapped(response, MAX_HTML_BYTES, deadline);
    if (read === "too-large") {
      return fail(
        "too-large",
        `The page is larger than ${MAX_HTML_BYTES / 1024 / 1024} MB and was not downloaded.`
      );
    }

    const html = decodeHtml(read.bytes, contentType);

    // `text/plain`, XML and a missing Content-Type all need the body to decide.
    const declaredHtml = mime === "text/html" || mime === "application/xhtml+xml";
    if (!declaredHtml && !looksLikeHtml(html)) {
      if (response.status >= 400) {
        return fail(
          "http-error",
          `The site returned HTTP ${response.status} and the response was not HTML.`,
          response.status
        );
      }
      return fail("not-html", `That URL did not return an HTML page (${mime || "no content type"}).`);
    }

    // fetch decompresses transparently, so the stream length is the *decoded*
    // size. Content-Length, when present, is the bytes actually on the wire.
    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    return {
      ok: true,
      document: {
        html,
        finalUrl: result.finalUrl,
        finalStatus: response.status,
        redirects: result.redirects,
        headers,
        ttfbMs: result.ttfbMs,
        totalMs: Date.now() - started,
        decodedBytes: read.length,
        bytes: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : read.length
      }
    };
  } catch (error) {
    return abortToFailure(error, deadline, Math.round(TOTAL_TIMEOUT_MS / 1000));
  } finally {
    deadline.dispose();
  }
}

/**
 * Fetches the audit target and assembles the full `PageContext`.
 *
 * Three phases, each strictly optional after the first. The main document is
 * fetched under one 15 s deadline; the sidecar resources then run in parallel
 * with their own 6 s deadlines; last comes the security reconnaissance under a
 * single 12 s budget. Everything after the document fails soft, so neither a
 * slow robots.txt nor an unreachable certificate can cost us the report.
 */
export async function fetchPageContext(
  rawUrl: string
): Promise<{ ok: true; ctx: PageContext } | AuditFailure> {
  const requestedUrl = normaliseUrl(rawUrl);
  if (!requestedUrl) {
    return fail("invalid-url", `"${rawUrl.trim()}" is not a valid website address.`);
  }

  let attempt = await fetchDocument(requestedUrl, false);
  let insecureFallback = false;

  if (!attempt.ok && shouldRetryInsecurely(attempt)) {
    /*
     * The certificate is broken - which is a finding, not a dead end.
     *
     * Refusing to look is how a site with an expired certificate ended up
     * getting no report at all, when it is exactly the site whose owner most
     * needs one. So we retry once, without validating the certificate, and
     * record that we did. Everything downstream - the TLS recon, every check
     * module, the report itself - then runs against a real page and can say
     * plainly what is wrong.
     *
     * The retry is not a weakening of the SSRF guard: `safeFetch` re-validates
     * the host on every hop either way. Only certificate *trust* is relaxed,
     * only for these requests, and never process-wide.
     */
    const retry = await fetchDocument(requestedUrl, true);
    if (retry.ok) {
      attempt = retry;
      insecureFallback = true;
    } else {
      // Both attempts failed. The user gets one sentence to act on, so spend a
      // handshake working out what the real problem was.
      let target: URL;
      try {
        target = new URL(requestedUrl);
      } catch {
        return publicFailure(attempt);
      }
      return describeTlsFailure(target, attempt);
    }
  }

  if (!attempt.ok) return publicFailure(attempt);

  const {
    html,
    finalUrl,
    finalStatus,
    redirects,
    headers,
    ttfbMs,
    totalMs,
    decodedBytes,
    bytes
  } = attempt.document;

  const finalUrlParsed = new URL(finalUrl);
  const origin = finalUrlParsed.origin;
  const doc = parseHtml(html, finalUrl);

  /* Sidecars: all optional, all parallel, all fail soft. --------------------- */

  const manifestHref = doc.links.find((link) =>
    link.rel.split(/\s+/).includes("manifest")
  )?.href;
  const sitemapLinkHref = doc.links.find((link) =>
    link.rel.split(/\s+/).includes("sitemap")
  )?.href;
  const hasIconTag = doc.links.some((link) =>
    link.rel.split(/\s+/).some((token) => token.endsWith("icon"))
  );

  const robots = await fetchRobots(origin, insecureFallback).catch(() => null);

  const [sitemap, llmsTxt, manifest, notFoundProbe, httpsRedirect, faviconStatus] =
    await Promise.allSettled([
      fetchSitemap(origin, robots?.sitemaps[0], sitemapLinkHref ?? undefined, insecureFallback),
      fetchLlmsTxt(origin, insecureFallback),
      manifestHref ? fetchManifest(manifestHref, insecureFallback) : Promise.resolve(null),
      probeNotFound(origin, insecureFallback),
      probeHttpsRedirect(finalUrlParsed),
      // Skip the network entirely when the document already declares an icon.
      hasIconTag
        ? Promise.resolve(null)
        : probeStatus(`${origin}/favicon.ico`, "GET", insecureFallback)
    ]);

  const settled = <T>(result: PromiseSettledResult<T>, fallback: T): T =>
    result.status === "fulfilled" ? result.value : fallback;

  const faviconProbeStatus = settled(faviconStatus, null);
  const notFound = settled(notFoundProbe, null);

  /* Security reconnaissance: one budgeted phase, everything optional. -------- */

  const recon = await runRecon({
    finalUrl: finalUrlParsed,
    origin,
    scripts: doc.scripts,
    notFoundBody: notFound?.body ?? null,
    insecure: insecureFallback
  }).catch(
    (): ReconResult => ({
      tls: null,
      exposedPaths: [],
      securityTxt: null,
      dns: null,
      rdap: null,
      methods: null,
      sourceMaps: [],
      directoryListing: []
    })
  );

  const ctx: PageContext = {
    requestedUrl,
    finalUrl,
    finalStatus,
    redirects,
    headers,
    html,
    bytes,
    decodedBytes,
    timings: { ttfbMs, totalMs },
    doc,
    https: finalUrlParsed.protocol === "https:",
    origin,
    robots,
    sitemap: settled(sitemap, null),
    llmsTxt: settled(llmsTxt, null),
    manifest: settled(manifest, null),
    // The 404 body was only ever needed to calibrate the exposure probes; it
    // does not belong in the context every check module can see.
    notFoundProbe: notFound ? { status: notFound.status, isSoft404: notFound.isSoft404 } : null,
    httpsRedirect: settled(httpsRedirect, { checked: false, redirectsToHttps: false }),
    faviconOk:
      hasIconTag ||
      (faviconProbeStatus !== null && faviconProbeStatus >= 200 && faviconProbeStatus < 300),
    insecureFallback,
    tls: recon.tls,
    exposedPaths: recon.exposedPaths,
    securityTxt: recon.securityTxt,
    dns: recon.dns,
    rdap: recon.rdap,
    methods: recon.methods,
    sourceMaps: recon.sourceMaps,
    directoryListing: recon.directoryListing
  };

  return { ok: true, ctx };
}
