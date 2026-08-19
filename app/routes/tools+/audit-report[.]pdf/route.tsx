/**
 * /tools/audit-report.pdf
 *
 * Resource route - action only, no component.
 *
 * The report exists only in the browser's `actionData` after a scan. Re-running
 * the audit here to build a PDF would be slow and would hit the target site a
 * second time, so the client posts back the report it already has and this
 * route renders it.
 *
 * That makes the report body *untrusted input from the network*, not our own
 * data structure. Everything below treats it that way: the body is size-capped
 * while it is still a stream, the JSON is validated field by field, and the
 * `AuditReport` handed to the renderer is rebuilt from scratch rather than cast
 * - so unknown keys are dropped and every field really has the type it claims.
 */

import type { Route } from "./+types/route";
import { CATEGORY_META } from "~/lib/audit/types";
import type {
  AuditReport,
  CategoryId,
  CategoryResult,
  Finding,
  Grade,
  PagePreview,
  RedirectHop,
  Severity,
  SeverityCounts,
} from "~/lib/audit/types";
import { auditPdfFilename, renderAuditPdf } from "~/lib/audit/pdf.server";
import { validateCsrf } from "~/lib/csrf.server";

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

/** A real report is tens to a few hundred KB serialised. 2 MB is generous. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Beyond this we are being asked to typeset a phone book, not a report. */
const MAX_FINDINGS = 3000;
const MAX_CATEGORIES = 64;
const MAX_REDIRECTS = 64;

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors the limiter in `tools/website-audit`. Typesetting a PDF is pure CPU
 * on the request thread, so this endpoint needs its own brake even though the
 * scan that produced the report was already limited. In-memory is enough for a
 * single-instance deploy; a multi-instance one would want a shared store.
 */
const RATE_LIMIT = { windowMs: 60_000, max: 10 };
const hits = new Map<string, number[]>();

function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

function rateLimited(request: Request): boolean {
  const key = clientKey(request);
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter(
    (at) => now - at < RATE_LIMIT.windowMs,
  );

  if (recent.length >= RATE_LIMIT.max) {
    hits.set(key, recent);
    return true;
  }

  recent.push(now);
  hits.set(key, recent);

  // Opportunistic cleanup so the map can't grow without bound.
  if (hits.size > 5000) {
    for (const [k, times] of hits) {
      if (times.every((at) => now - at >= RATE_LIMIT.windowMs)) hits.delete(k);
    }
  }

  return false;
}

/* -------------------------------------------------------------------------- */
/* Responses                                                                   */
/* -------------------------------------------------------------------------- */

/** Plain-text error. Nothing here is cacheable - it is all user-supplied. */
function problem(status: number, reason: string, extra?: HeadersInit): Response {
  return new Response(`${reason}\n`, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...Object.fromEntries(new Headers(extra ?? {})),
    },
  });
}

/**
 * Reduces a filename to characters that cannot mean anything inside a
 * `Content-Disposition` header - no quotes, no backslashes, no CR/LF, no
 * semicolons, nothing non-ASCII. The result is safe to interpolate into a
 * quoted-string without any further escaping.
 */
function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const stem = base
    // Control characters (CR/LF included) are removed outright rather than
    // collapsed into padding.
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\.pdf$/i, "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+/, "")
    .replace(/[-._]+$/, "")
    .slice(0, 120);

  return `${stem || "audit-report"}.pdf`;
}

/* -------------------------------------------------------------------------- */
/* Body reading                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Reads the request body, refusing to buffer more than `limit` bytes.
 *
 * `request.formData()` would happily materialise however much the client sent
 * before we got a chance to look at it, so the cap is applied to the stream.
 * Returns null when the body is too large.
 */
async function readBodyCapped(
  request: Request,
  limit: number,
): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return null;

  const body = request.body;
  if (!body) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(joined);
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/** Thrown by the parsers below; caught once, turned into a 400. */
class InvalidReport extends Error {}

function fail(message: string): never {
  throw new InvalidReport(message);
}

const SEVERITIES: readonly Severity[] = ["critical", "warning", "info", "pass"];
const GRADES: readonly Grade[] = ["A", "B", "C", "D", "F"];
const CATEGORY_IDS: readonly string[] = Object.keys(CATEGORY_META);

function isSeverity(value: string): value is Severity {
  return (SEVERITIES as readonly string[]).includes(value);
}

function isGrade(value: string): value is Grade {
  return (GRADES as readonly string[]).includes(value);
}

function isCategoryId(value: string): value is CategoryId {
  return CATEGORY_IDS.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function httpUrlOrNull(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/* --- field readers. Each narrows through `unknown` and fails loudly. ------- */

function obj(source: Record<string, unknown>, key: string, at: string) {
  const value = source[key];
  if (!isRecord(value)) fail(`${at}.${key} must be an object.`);
  return value;
}

function arr(source: Record<string, unknown>, key: string, at: string): unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) fail(`${at}.${key} must be an array.`);
  return value;
}

function str(source: Record<string, unknown>, key: string, at: string): string {
  const value = source[key];
  if (typeof value !== "string") fail(`${at}.${key} must be a string.`);
  return value;
}

function optionalStr(
  source: Record<string, unknown>,
  key: string,
  at: string,
): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") fail(`${at}.${key} must be a string.`);
  return value;
}

function nullableStr(
  source: Record<string, unknown>,
  key: string,
  at: string,
): string | null {
  const value = source[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") fail(`${at}.${key} must be a string or null.`);
  return value;
}

function num(source: Record<string, unknown>, key: string, at: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${at}.${key} must be a finite number.`);
  }
  return value;
}

function optionalNum(
  source: Record<string, unknown>,
  key: string,
  at: string,
): number | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${at}.${key} must be a finite number.`);
  }
  return value;
}

/* --- structures ----------------------------------------------------------- */

function parseCounts(source: Record<string, unknown>, at: string): SeverityCounts {
  return {
    critical: num(source, "critical", at),
    warning: num(source, "warning", at),
    info: num(source, "info", at),
    pass: num(source, "pass", at),
  };
}

function parseFinding(input: unknown, at: string): Finding {
  if (!isRecord(input)) fail(`${at} must be an object.`);

  const id = str(input, "id", at);
  if (!id) fail(`${at}.id must not be empty.`);

  const title = str(input, "title", at);
  const severity = str(input, "severity", at);
  if (!isSeverity(severity)) {
    fail(`${at}.severity must be one of ${SEVERITIES.join(", ")}.`);
  }

  const category = str(input, "category", at);
  if (!isCategoryId(category)) fail(`${at}.category is not a known category.`);

  return {
    id,
    category,
    severity,
    title,
    detail: typeof input.detail === "string" ? input.detail : "",
    fix: optionalStr(input, "fix", at),
    snippet: optionalStr(input, "snippet", at),
    value: optionalStr(input, "value", at),
    docs: optionalStr(input, "docs", at),
    weight: optionalNum(input, "weight", at),
  };
}

function parseCategory(
  input: unknown,
  at: string,
  budget: { findings: number },
): CategoryResult {
  if (!isRecord(input)) fail(`${at} must be an object.`);

  const id = str(input, "id", at);
  if (!isCategoryId(id)) fail(`${at}.id is not a known category.`);

  const findings = arr(input, "findings", at);
  budget.findings += findings.length;
  if (budget.findings > MAX_FINDINGS) {
    fail(`Report carries more than ${MAX_FINDINGS} findings.`);
  }

  return {
    id,
    label: str(input, "label", at),
    blurb: str(input, "blurb", at),
    score: num(input, "score", at),
    weight: num(input, "weight", at),
    findings: findings.map((finding, i) =>
      parseFinding(finding, `${at}.findings[${i}]`),
    ),
    counts: parseCounts(obj(input, "counts", at), `${at}.counts`),
  };
}

function parsePreview(source: Record<string, unknown>, at: string): PagePreview {
  return {
    title: nullableStr(source, "title", at),
    description: nullableStr(source, "description", at),
    ogTitle: nullableStr(source, "ogTitle", at),
    ogDescription: nullableStr(source, "ogDescription", at),
    // Image fields are URLs the renderer may well try to load. Anything that is
    // not plain http(s) - `file:`, `data:`, `javascript:` - is dropped here so a
    // hand-crafted report cannot point the renderer somewhere interesting.
    ogImage: httpUrlOrNull(nullableStr(source, "ogImage", at)),
    twitterCard: nullableStr(source, "twitterCard", at),
    twitterImage: httpUrlOrNull(nullableStr(source, "twitterImage", at)),
    siteName: nullableStr(source, "siteName", at),
    favicon: httpUrlOrNull(nullableStr(source, "favicon", at)),
    displayUrl: str(source, "displayUrl", at),
  };
}

function parseRedirect(input: unknown, at: string): RedirectHop {
  if (!isRecord(input)) fail(`${at} must be an object.`);
  return {
    from: str(input, "from", at),
    to: str(input, "to", at),
    status: num(input, "status", at),
  };
}

/**
 * Builds a genuine `AuditReport` out of arbitrary parsed JSON, or throws
 * `InvalidReport`. Nothing is cast: every field is checked and copied, so the
 * object handed to the renderer contains only what the type promises.
 */
function parseReport(input: unknown): AuditReport {
  if (!isRecord(input)) fail("Report must be a JSON object.");

  const score = num(input, "score", "report");
  if (score < 0 || score > 100) fail("report.score must be between 0 and 100.");

  const grade = str(input, "grade", "report");
  if (!isGrade(grade)) fail(`report.grade must be one of ${GRADES.join(", ")}.`);

  const finalUrl = str(input, "finalUrl", "report");
  if (httpUrlOrNull(finalUrl) === null) {
    fail("report.finalUrl must be an http(s) URL.");
  }

  const categories = arr(input, "categories", "report");
  if (categories.length > MAX_CATEGORIES) {
    fail(`Report carries more than ${MAX_CATEGORIES} categories.`);
  }

  const redirects = arr(input, "redirects", "report");
  if (redirects.length > MAX_REDIRECTS) {
    fail(`Report carries more than ${MAX_REDIRECTS} redirects.`);
  }

  const budget = { findings: 0 };
  const timings = obj(input, "timings", "report");
  const stats = obj(input, "stats", "report");

  return {
    requestedUrl: str(input, "requestedUrl", "report"),
    finalUrl,
    finalStatus: num(input, "finalStatus", "report"),
    fetchedAt: str(input, "fetchedAt", "report"),
    score,
    grade,
    categories: categories.map((category, i) =>
      parseCategory(category, `report.categories[${i}]`, budget),
    ),
    counts: parseCounts(obj(input, "counts", "report"), "report.counts"),
    preview: parsePreview(obj(input, "preview", "report"), "report.preview"),
    redirects: redirects.map((hop, i) =>
      parseRedirect(hop, `report.redirects[${i}]`),
    ),
    timings: {
      ttfbMs: num(timings, "ttfbMs", "report.timings"),
      totalMs: num(timings, "totalMs", "report.timings"),
    },
    stats: {
      htmlBytes: num(stats, "htmlBytes", "report.stats"),
      wordCount: num(stats, "wordCount", "report.stats"),
      imageCount: num(stats, "imageCount", "report.stats"),
      linkCount: num(stats, "linkCount", "report.stats"),
      scriptCount: num(stats, "scriptCount", "report.stats"),
      textToHtmlRatio: num(stats, "textToHtmlRatio", "report.stats"),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Route                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Nothing to GET here - the PDF only exists as a function of a posted report.
 * Answering 405 rather than letting the action-less GET blow up keeps a stray
 * visit to the URL from looking like a server fault.
 */
export function loader() {
  return problem(
    405,
    "Method not allowed. POST an audit report to this URL to render it as a PDF.",
    { Allow: "POST" },
  );
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return problem(405, "Method not allowed.", { Allow: "POST" });
  }

  const raw = await readBodyCapped(request, MAX_BODY_BYTES);
  if (raw === null) {
    return problem(
      413,
      `Report too large. The request body must be under ${Math.round(MAX_BODY_BYTES / 1024)} KB.`,
    );
  }

  // Rebuilt from the capped body rather than `request.formData()`, which would
  // have buffered the whole thing before we could measure it.
  const form = new FormData();
  for (const [key, value] of new URLSearchParams(raw)) form.append(key, value);

  try {
    await validateCsrf(request, form);
  } catch {
    return problem(403, "Invalid or missing CSRF token. Refresh the page and try again.");
  }

  if (rateLimited(request)) {
    return problem(429, "Too many PDF requests. Give it a minute and try again.", {
      "Retry-After": String(Math.ceil(RATE_LIMIT.windowMs / 1000)),
    });
  }

  const serialised = form.get("report");
  if (typeof serialised !== "string" || !serialised.trim()) {
    return problem(400, "Missing `report` field.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialised);
  } catch {
    return problem(400, "`report` is not valid JSON.");
  }

  let report: AuditReport;
  try {
    report = parseReport(parsed);
  } catch (error) {
    if (error instanceof InvalidReport) return problem(400, error.message);
    throw error;
  }

  let pdf: Buffer;
  try {
    pdf = await renderAuditPdf(report);
  } catch {
    return problem(500, "Could not render the PDF. Try again.");
  }

  const filename = safeFilename(auditPdfFilename(report));

  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      // `filename` is ASCII [A-Za-z0-9._-] only after `safeFilename`, so the
      // quoted-string cannot be broken out of.
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(pdf.byteLength),
      // Derived entirely from a user-supplied body - never cache or share it.
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
