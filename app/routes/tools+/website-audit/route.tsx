/**
 * /tools/website-audit: the interactive audit tool.
 *
 * This is a hand-written React route rather than a CMS page because the report is
 * a live React tree fed by a server action; a `.page` can only hold static HTML.
 * The /tools *index* is a normal CMS page and stays editable in the page builder.
 *
 * Self-contained by design: it mints its own CSRF token in the loader and paints
 * its own dark shell, so neither root.tsx nor app.css needs changing.
 */

import { useEffect, useRef } from "react";
import { Form, useNavigation, useSubmit } from "react-router";
import {
  AlertTriangle,
  ArrowLeft,
  Loader2,
  Radar,
  Search,
  ShieldCheck,
} from "lucide-react";
import type { Route } from "./+types/route";
import { CsrfInput, CsrfProvider } from "~/components/csrf-input";
import AuditReportView from "~/components/tools/audit/report";
import { runAudit } from "~/lib/audit/audit.server";
import type { AuditResult } from "~/lib/audit/types";
import { ensureCsrfToken, validateCsrf } from "~/lib/csrf.server";
import { getSiteChrome } from "~/lib/site-chrome.server";

type ActionResult = AuditResult & { requested?: string };

export function meta() {
  return [
    { title: "Website Audit · SEO, Open Graph & AI readiness scanner · Devforge" },
    {
      name: "description",
      content:
        "Scan any website for SEO, meta tag, Open Graph, structured data, AI crawler readiness, accessibility, performance and security issues. Free, no sign-up.",
    },
    { name: "robots", content: "index, follow" },
  ];
}

/** Mints the CSRF token for the form below and sets the matching cookie. */
export async function loader({ request }: Route.LoaderArgs) {
  const [{ token, setCookie }, chrome] = await Promise.all([
    ensureCsrfToken(request),
    getSiteChrome(),
  ]);
  // `?url=` lets a CMS page hand a URL over. A static page cannot mint a CSRF
  // token so it cannot POST here; this carries the intent instead and the scan
  // still runs as a protected POST once this page has loaded.
  const prefill = (new URL(request.url).searchParams.get("url") ?? "").trim();
  const data = { csrfToken: token, chrome, prefill: prefill.slice(0, 2048) };
  if (!setCookie) return data;
  return Response.json(data, { headers: { "Set-Cookie": setCookie } });
}

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                               */
/* -------------------------------------------------------------------------- */

/**
 * This endpoint makes the server fetch a URL of the caller's choosing, so it
 * needs a brake. In-memory is enough for a single-instance deploy; a
 * multi-instance one would want this in a shared store.
 */
const RATE_LIMIT = { windowMs: 60_000, max: 8 };
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
/* Action                                                                      */
/* -------------------------------------------------------------------------- */

export async function action({
  request,
}: Route.ActionArgs): Promise<ActionResult> {
  const form = await request.formData();

  try {
    await validateCsrf(request, form);
  } catch {
    return {
      ok: false,
      code: "invalid-url",
      message: "Your session expired. Refresh the page and try again.",
    };
  }

  const url = String(form.get("url") ?? "").trim();

  if (!url) {
    return { ok: false, code: "invalid-url", message: "Enter a URL to scan." };
  }

  if (rateLimited(request)) {
    return {
      ok: false,
      code: "network-error",
      message: "That's a lot of scans. Give it a minute and try again.",
      requested: url,
    };
  }

  const result = await runAudit(url);
  return { ...result, requested: url };
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

const EXAMPLES = ["stripe.com", "news.ycombinator.com", "devforge.io"];

export default function WebsiteAuditRoute({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const result = actionData as ActionResult | undefined;
  const navigation = useNavigation();
  const scanning = navigation.state === "submitting";
  const prefill = loaderData.prefill;
  const formRef = useRef<HTMLFormElement>(null);
  const submit = useSubmit();

  // Handed a URL from elsewhere on the site: run it rather than making the
  // visitor press the button again. Without JS the field is simply prefilled.
  const handedOff = Boolean(prefill) && !actionData;
  useEffect(() => {
    if (handedOff && formRef.current) submit(formRef.current, { method: "post" });
  }, [handedOff, submit]);

  const chrome = loaderData.chrome;

  return (
    <CsrfProvider token={loaderData.csrfToken}>
      {/* The site's own stylesheet, so the CMS header/footer below look exactly
          as they do on every other page. It also supplies the dark ground and
          Geist face this fork's light <body> would otherwise leave unset. */}
      {chrome.css ? (
        <style dangerouslySetInnerHTML={{ __html: chrome.css }} />
      ) : null}

      <div className="min-h-screen bg-[#08060f] font-sans text-white antialiased">
        {chrome.headerHtml ? (
          <div dangerouslySetInnerHTML={{ __html: chrome.headerHtml }} />
        ) : null}

        <main>
          <div className="relative overflow-hidden px-5 pt-28 pb-24 sm:px-8">
          <div
            className="pointer-events-none absolute inset-0 print:hidden"
            style={{
              background:
                "radial-gradient(110% 80% at 50% -10%, rgba(249,115,22,0.15) 0%, transparent 55%)",
            }}
          />

          <div className="relative mx-auto max-w-6xl">
            {/* A plain anchor, not <Link>: /tools is a CMS page served by the
                splat resource route, which has no component, so a client-side
                navigation there renders a blank document. */}
            <a
              href="/tools"
              className="mb-6 inline-flex w-fit items-center gap-1.5 font-mono text-xs text-white/45 transition-colors hover:text-[#f5a524] print:hidden"
            >
              <ArrowLeft size={14} aria-hidden="true" />
              All tools
            </a>

            <div className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.24em] text-[#f5a524]/70">
              <Radar size={13} aria-hidden="true" />
              Website Audit
            </div>
            <h1 className="text-4xl font-semibold leading-[1.08] tracking-tight text-white sm:text-5xl">
              What's wrong with{" "}
              <span
                style={{
                  background:
                    "linear-gradient(120deg, #ffcf5c, #f97316 55%, #ef4444)",
                  WebkitBackgroundClip: "text",
                  backgroundClip: "text",
                  color: "transparent",
                }}
              >
                your website
              </span>
              ?
            </h1>
            <p className="mt-5 max-w-2xl text-lg leading-relaxed text-white/60">
              Paste a URL. It fetches the page, reads the markup, probes{" "}
              <code className="font-mono text-sm text-white/75">robots.txt</code>
              ,{" "}
              <code className="font-mono text-sm text-white/75">
                sitemap.xml
              </code>{" "}
              and{" "}
              <code className="font-mono text-sm text-white/75">llms.txt</code>,
              inspects the TLS certificate and DNS records, and grades what it
              finds: meta tags, Open Graph cards, structured data, AI crawler
              access, accessibility, performance, security headers, exposed files
              and email spoofing protection.
            </p>

            {/* Scan form */}
            <div className="relative mt-8 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:p-6 print:hidden">
              <span
                className="pointer-events-none absolute inset-x-0 top-0 h-px"
                style={{
                  background:
                    "linear-gradient(90deg, transparent, #f5a524, #ef4444, transparent)",
                }}
              />

              <Form ref={formRef} method="post" className="flex flex-col gap-3 sm:flex-row">
                <CsrfInput />

                <label className="sr-only" htmlFor="url">
                  Website URL
                </label>
                <div className="relative flex-1">
                  <Search
                    className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/25"
                    aria-hidden="true"
                  />
                  <input
                    id="url"
                    name="url"
                    type="text"
                    inputMode="url"
                    autoComplete="url"
                    autoCapitalize="off"
                    spellCheck={false}
                    required
                    defaultValue={result?.requested ?? prefill}
                    placeholder="example.com"
                    className="w-full rounded-full border border-white/10 bg-white/[0.03] py-3 pl-10 pr-4 text-sm text-white outline-none transition-colors placeholder:text-white/30 focus:border-[#f5a524]/45 focus:bg-white/[0.05]"
                  />
                </div>

                <button
                  type="submit"
                  disabled={scanning}
                  className="group inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 text-sm font-medium transition-all duration-300 hover:-translate-y-0.5 disabled:opacity-60 disabled:hover:translate-y-0"
                  style={{
                    background:
                      "linear-gradient(120deg, #ffcf5c, #f97316 55%, #ef4444)",
                    color: "#1a0f00",
                    boxShadow: "0 8px 30px -10px rgba(249,115,22,0.6)",
                  }}
                >
                  {scanning ? (
                    <>
                      Scanning
                      <Loader2
                        className="h-4 w-4 animate-spin"
                        aria-hidden="true"
                      />
                    </>
                  ) : (
                    <>
                      Scan site
                      <Radar
                        className="h-4 w-4 transition-transform group-hover:rotate-45"
                        aria-hidden="true"
                      />
                    </>
                  )}
                </button>
              </Form>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-white/35">
                  Try
                </span>
                {EXAMPLES.map((example) => (
                  <Form key={example} method="post" className="contents">
                    <CsrfInput />
                    <input type="hidden" name="url" value={example} />
                    <button
                      type="submit"
                      disabled={scanning}
                      className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-[11px] text-white/45 transition-colors hover:border-white/20 hover:text-white/70 disabled:opacity-50"
                    >
                      {example}
                    </button>
                  </Form>
                ))}
              </div>

              <p className="mt-4 border-t border-white/[0.06] pt-3 text-xs leading-relaxed text-white/35">
                <ShieldCheck
                  className="mr-1.5 inline h-3.5 w-3.5 -translate-y-px text-white/30"
                  aria-hidden="true"
                />
                Scan sites you own or are authorised to test. The security checks
                are read-only reconnaissance: ordinary GET requests to
                conventional paths, a TLS handshake and public DNS lookups. No
                payloads, no traversal, no credential guessing, nothing written to
                the target.
              </p>
            </div>

            {(scanning || handedOff) && <ScanningState />}

            {!scanning && result && !result.ok && (
              <FailureCard message={result.message} code={result.code} />
            )}

            {!scanning && result?.ok && (
              <div className="mt-10">
                <AuditReportView report={result.report} />
              </div>
            )}

            {!result && !scanning && !handedOff && <EmptyState />}
            </div>
          </div>
        </main>

        {chrome.footerHtml ? (
          <div dangerouslySetInnerHTML={{ __html: chrome.footerHtml }} />
        ) : null}
      </div>
    </CsrfProvider>
  );
}

function ScanningState() {
  const steps = [
    "Fetching the page",
    "Parsing markup",
    "Probing robots.txt, sitemap.xml, llms.txt",
    "Inspecting TLS certificate and DNS records",
    "Checking for exposed files and source maps",
    "Running checks",
  ];

  return (
    <div className="mt-10 rounded-2xl border border-white/10 bg-white/[0.02] p-8">
      <div className="flex items-center gap-3">
        <Loader2
          className="h-5 w-5 animate-spin text-[#f5a524]"
          aria-hidden="true"
        />
        <span className="text-lg font-semibold text-white">Scanning…</span>
      </div>
      <ul className="mt-5 space-y-2">
        {steps.map((step) => (
          <li
            key={step}
            className="flex items-center gap-2 font-mono text-xs text-white/40"
          >
            <span className="h-1 w-1 rounded-full bg-[#f5a524]/50" />
            {step}
          </li>
        ))}
      </ul>
      <p className="mt-5 text-xs text-white/30">
        Usually a few seconds. Slow origins can take up to 15.
      </p>
    </div>
  );
}

function FailureCard({ message, code }: { message: string; code: string }) {
  return (
    <div
      role="alert"
      className="mt-10 flex items-start gap-3 rounded-2xl border border-[#ef4444]/30 bg-[#ef4444]/[0.06] p-5"
    >
      <AlertTriangle
        className="mt-0.5 h-5 w-5 shrink-0 text-[#ef4444]"
        aria-hidden="true"
      />
      <div>
        <h2 className="text-base font-semibold text-white">
          Couldn't scan that site
        </h2>
        <p className="mt-1 text-sm text-white/60">{message}</p>
        <p className="mt-2 font-mono text-[11px] uppercase tracking-wider text-[#ef4444]/50">
          {code}
        </p>
      </div>
    </div>
  );
}

function EmptyState() {
  const covered = [
    ["Meta tags", "Title, description, canonical, viewport, robots directives"],
    ["SEO", "Heading structure, link quality, crawlability, thin content"],
    [
      "Open Graph & social",
      "How the page unfurls on X, Facebook, Slack, iMessage",
    ],
    [
      "AI readiness",
      "GPTBot, ClaudeBot, PerplexityBot access, llms.txt, JS-shell detection",
    ],
    ["Structured data", "JSON-LD validity and schema.org completeness"],
    ["Accessibility", "Alt text, form labels, landmarks, language, zoom"],
    ["Performance", "Payload, compression, caching, render-blocking resources"],
    ["Security headers", "HSTS, CSP, clickjacking, cookie flags, version leaks"],
    [
      "Exposed files & leakage",
      "Stray .env and .git, source maps, directory listings, secrets in markup",
    ],
    [
      "TLS & certificate",
      "Chain trust, expiry, hostname match, legacy protocols, cipher strength",
    ],
    ["Email & DNS", "SPF lookup limits, DMARC policy, DKIM selectors, CAA"],
    [
      "Domain & registration",
      "Expiry, transfer locks, DNSSEC and registrar, straight from RDAP",
    ],
    ["Technical", "Redirect chains, soft 404s, mixed content, manifests"],
  ];

  return (
    <div className="mt-12">
      <div className="mb-4 font-mono text-[11px] uppercase tracking-[0.24em] text-white/35">
        What gets checked
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {covered.map(([title, blurb]) => (
          <div
            key={title}
            className="rounded-xl border border-white/10 bg-white/[0.02] p-4"
          >
            <div className="text-sm font-medium text-white/80">{title}</div>
            <p className="mt-1.5 text-xs leading-relaxed text-white/40">
              {blurb}
            </p>
          </div>
        ))}
      </div>
      <p className="mt-6 max-w-2xl text-xs leading-relaxed text-white/30">
        Static analysis only: the page is fetched and parsed, not rendered in a
        browser. Core Web Vitals, colour contrast and keyboard behaviour need a
        real browser session and aren't covered here.
      </p>
    </div>
  );
}
