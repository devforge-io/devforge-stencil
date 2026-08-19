import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Form } from "react-router";
import { ArrowRight, Download, ExternalLink, Flame, Loader2, ShieldCheck } from "lucide-react";
import { twMerge } from "tailwind-merge";
import { CsrfInput } from "~/components/csrf-input";
import { CATEGORY_ORDER } from "~/lib/audit/types";
import type { AuditReport, CategoryResult, Finding, Grade } from "~/lib/audit/types";
import { CategoryPanel, categoryAnchorId } from "./category-panel";
import { FindingRow } from "./finding-row";
import { PreviewCards } from "./preview-cards";
import { ScoreRing, scoreColor, scoreTextClass } from "./score-ring";
import { SEVERITY_ORDER, SEVERITY_STYLE, severityCountLabel } from "./severity";

/**
 * Jumps to a category panel without navigating.
 *
 * The report only exists in the route's `actionData`, which React Router
 * discards on the next navigation - so letting the browser follow the `#` href
 * threw the results away and dropped the user back on an empty form.
 *
 * Instead: cancel the default, write the hash with `replaceState` (a history
 * edit, not a navigation, so the URL stays shareable), tell the panels to open
 * via the `hashchange` event they already listen for, then scroll.
 *
 * The element keeps a real `href`, so middle-click, open-in-new-tab and the
 * no-JS path all still behave normally.
 */
function jumpToCategory(
  event: React.MouseEvent<HTMLAnchorElement>,
  anchorId: string,
): void {
  // Leave modified clicks (new tab/window) and non-primary buttons alone.
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }

  const target = document.getElementById(anchorId);
  if (!target) return;

  event.preventDefault();

  const hash = `#${anchorId}`;
  if (window.location.hash !== hash) {
    window.history.replaceState(window.history.state, "", hash);
  }
  // The panels open themselves off `hashchange`; replaceState does not emit it.
  window.dispatchEvent(new HashChangeEvent("hashchange"));

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Deterministic thousands separators - `toLocaleString` would desync SSR/CSR. */
function formatNumber(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** UTC, formatted by hand so the server and the client agree. */
function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}

function verdictFor(score: number): string {
  if (score >= 90) {
    return "Excellent. The fundamentals are in place and this page presents itself well everywhere it is shared.";
  }
  if (score >= 75) {
    return "Solid. A handful of targeted fixes would take this page from good to genuinely competitive.";
  }
  if (score >= 50) {
    return "Workable, but there is real ground to make up - several signals search engines rely on are missing.";
  }
  if (score >= 25) {
    return "Struggling. Enough fundamentals are absent that search engines and social platforms are guessing.";
  }
  return "Critical. This page is close to invisible to search engines and renders as a bare link when shared.";
}

const GRADE_TEXT: Record<Grade, string> = {
  A: "text-emerald-300",
  B: "text-lime-300",
  C: "text-amber-300",
  D: "text-orange-300",
  F: "text-rose-300",
};

/* -------------------------------------------------------------------------- */
/* Shared shells                                                               */
/* -------------------------------------------------------------------------- */

const CARD =
  "relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-xl print:border-black/15 print:bg-white print:backdrop-blur-none print:break-inside-avoid";

const HAIRLINE =
  "linear-gradient(90deg, transparent, rgba(244,63,94,0.55), rgba(129,140,248,0.4), rgba(6,182,212,0.3), transparent)";

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="font-mono text-[11px] tracking-[0.28em] text-[#f5a524]/70 print:text-black/60">
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* PDF download                                                                */
/* -------------------------------------------------------------------------- */

/** How long the button stays in its "preparing" state before resetting itself. */
const PREPARING_TIMEOUT_MS = 20_000;

/**
 * Posts the report back to `/tools/audit-report.pdf`, which typesets it.
 *
 * The report only exists in this page's `actionData`; re-running the audit
 * server-side to build the PDF would be slow and would hit the audited site a
 * second time, so the bytes we already have go back over the wire instead.
 *
 * `reloadDocument` is load-bearing. A client-side `<Form>` would fetch the
 * response and try to treat it as a navigation - React Router has nothing to do
 * with a PDF body, so nothing would download and the results on screen would be
 * thrown away. Letting the browser perform the POST natively means
 * `Content-Disposition: attachment` does its job and this page is left exactly
 * as it was.
 */
function DownloadPdfButton({ report }: { report: AuditReport }) {
  const [preparing, setPreparing] = useState(false);

  // Several hundred KB of JSON; don't rebuild it on every render.
  const serialised = useMemo(() => JSON.stringify(report), [report]);

  /**
   * A native download is invisible to the page - there is no load event and
   * `useNavigation()` never sees the submit - so the spinner has to time itself
   * out. Window focus covers the case where the browser opened a save dialog;
   * the timer covers everything else, including a failed render. Either way the
   * button never stays disabled.
   */
  useEffect(() => {
    if (!preparing) return;

    const done = () => setPreparing(false);
    const timer = window.setTimeout(done, PREPARING_TIMEOUT_MS);
    window.addEventListener("focus", done);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", done);
    };
  }, [preparing]);

  return (
    <Form
      method="post"
      action="/tools/audit-report.pdf"
      reloadDocument
      onSubmit={() => setPreparing(true)}
      className="print:hidden"
    >
      <CsrfInput />
      <input type="hidden" name="report" value={serialised} />

      <button
        type="submit"
        disabled={preparing}
        className={twMerge(
          "group inline-flex items-center gap-2 rounded-lg px-4 py-2",
          "font-mono text-[11px] uppercase tracking-[0.18em]",
          "transition-all hover:-translate-y-0.5",
          "disabled:opacity-60 disabled:hover:translate-y-0",
        )}
        style={{
          background: "linear-gradient(120deg, #ffcf5c, #f97316 55%, #ef4444)",
          color: "#1a0f00",
          boxShadow: "0 8px 30px -10px rgba(249,115,22,0.6)",
        }}
      >
        {preparing ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            Preparing
          </>
        ) : (
          <>
            <Download
              className="h-3.5 w-3.5 transition-transform group-hover:translate-y-0.5"
              aria-hidden="true"
            />
            Download PDF
          </>
        )}
      </button>
    </Form>
  );
}

/* -------------------------------------------------------------------------- */
/* Report                                                                      */
/* -------------------------------------------------------------------------- */

export default function AuditReportView({ report }: { report: AuditReport }) {
  const categories = orderCategories(report.categories);
  const topFixes = pickTopFixes(categories, 6);
  const redirected = report.requestedUrl !== report.finalUrl;

  const stats: { label: string; value: string }[] = [
    { label: "HTML size", value: formatBytes(report.stats.htmlBytes) },
    { label: "Words", value: formatNumber(report.stats.wordCount) },
    { label: "Images", value: formatNumber(report.stats.imageCount) },
    { label: "Links", value: formatNumber(report.stats.linkCount) },
    { label: "Scripts", value: formatNumber(report.stats.scriptCount) },
    { label: "Text ratio", value: `${Math.round(report.stats.textToHtmlRatio * 100)}%` },
    { label: "TTFB", value: formatMs(report.timings.ttfbMs) },
    { label: "Total", value: formatMs(report.timings.totalMs) },
  ];

  return (
    <div className="mx-auto w-full max-w-5xl print:max-w-none">
      {/* ---------------------------------------------------------------- Hero */}
      <section
        className={twMerge(CARD, "p-6 sm:p-8")}
        style={{ boxShadow: "0 0 0 1px rgba(244,63,94,0.04), 0 24px 64px rgba(0,0,0,0.45)" }}
        aria-labelledby="audit-summary"
      >
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-px print:hidden"
          style={{ background: HAIRLINE }}
        />

        <div className="flex flex-col items-center gap-7 sm:flex-row sm:items-start sm:gap-8">
          <div className="flex flex-col items-center gap-2">
            <ScoreRing score={report.score} size={148} label="Overall" />
            <div
              className={twMerge(
                "font-mono text-sm font-semibold tracking-[0.2em]",
                GRADE_TEXT[report.grade],
                "print:text-black",
              )}
            >
              GRADE {report.grade}
            </div>
          </div>

          <div className="min-w-0 flex-1 text-center sm:text-left">
            <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start sm:justify-between">
              <Eyebrow>AUDIT REPORT</Eyebrow>
              <DownloadPdfButton report={report} />
            </div>

            <h2
              id="audit-summary"
              className="mt-2 break-words font-mono text-xl font-semibold tracking-tight text-white sm:text-2xl print:text-black"
            >
              <a
                href={report.finalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-baseline gap-1.5 underline-offset-4 transition-colors hover:text-[#f5a524] hover:underline"
              >
                <span className="break-all">{report.finalUrl}</span>
                <ExternalLink size={14} className="shrink-0 self-center" aria-hidden="true" />
              </a>
            </h2>

            <p className="mt-3 text-sm leading-relaxed text-white/55 print:text-black/70">
              {verdictFor(report.score)}
            </p>

            <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 font-mono text-[11px] text-white/40 sm:justify-start print:text-black/60">
              <span className="inline-flex items-center gap-1.5">
                <span
                  className={twMerge(
                    "h-1.5 w-1.5 rounded-full",
                    report.finalStatus >= 200 && report.finalStatus < 300
                      ? "bg-emerald-400"
                      : "bg-amber-400",
                  )}
                  aria-hidden="true"
                />
                HTTP {report.finalStatus}
              </span>
              <span>
                Fetched <time dateTime={report.fetchedAt}>{formatTimestamp(report.fetchedAt)}</time>
              </span>
              {redirected ? (
                <span className="break-all">Requested {report.requestedUrl}</span>
              ) : null}
            </div>

            <ul className="mt-5 flex flex-wrap items-center justify-center gap-2 sm:justify-start">
              {SEVERITY_ORDER.map((severity) => (
                <li key={severity}>
                  <span
                    className={twMerge(
                      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] tabular-nums",
                      SEVERITY_STYLE[severity].border,
                      SEVERITY_STYLE[severity].bg,
                      SEVERITY_STYLE[severity].text,
                      "print:border-black/20 print:bg-transparent print:text-black",
                    )}
                  >
                    <span
                      className={twMerge(
                        "h-1.5 w-1.5 rounded-full",
                        SEVERITY_STYLE[severity].dot,
                        "print:bg-black",
                      )}
                      aria-hidden="true"
                    />
                    {severityCountLabel(severity, report.counts[severity])}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------------- Stats */}
      <section className="mt-5" aria-label="Page statistics">
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-8">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2.5 print:border-black/15 print:bg-white"
            >
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/40 print:text-black/55">
                {stat.label}
              </div>
              <div className="mt-1 font-mono text-sm font-medium tabular-nums text-white print:text-black">
                {stat.value}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------ Category index */}
      {categories.length > 0 ? (
        <section className="mt-5" aria-label="Category scores">
          <div className={twMerge(CARD, "p-4 sm:p-5")}>
            <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
              {categories.map((category) => (
                <a
                  key={category.id}
                  href={`#${categoryAnchorId(category.id)}`}
                  onClick={(event) => jumpToCategory(event, categoryAnchorId(category.id))}
                  className="group block rounded-lg px-2 py-1.5 transition-colors hover:bg-white/[0.04] print:hover:bg-transparent"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate font-mono text-[11px] uppercase tracking-[0.16em] text-white/55 transition-colors group-hover:text-white print:text-black/70">
                      {category.label}
                    </span>
                    <span
                      className={twMerge(
                        "shrink-0 font-mono text-[13px] font-semibold tabular-nums",
                        scoreTextClass(category.score),
                        "print:text-black",
                      )}
                    >
                      {Math.round(category.score)}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/10 print:bg-black/10">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(2, Math.min(100, category.score))}%`,
                        background: scoreColor(category.score),
                      }}
                    />
                  </div>
                </a>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {/* ---------------------------------------------------------- Redirects */}
      {report.redirects.length > 0 ? (
        <section className="mt-5" aria-labelledby="audit-redirects">
          <div className={twMerge(CARD, "p-5")}>
            <h2
              id="audit-redirects"
              className="font-mono text-sm font-semibold tracking-tight text-white print:text-black"
            >
              Redirect chain
              <span className="ml-2 font-mono text-[11px] font-normal text-white/40 print:text-black/60">
                {report.redirects.length} hop{report.redirects.length === 1 ? "" : "s"} before the
                final document
              </span>
            </h2>

            <ol className="mt-3 space-y-2">
              {report.redirects.map((hop, i) => (
                <li
                  key={`${hop.from}-${hop.to}-${i}`}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] leading-relaxed"
                >
                  <span className="rounded border border-white/10 bg-black/30 px-1.5 py-0.5 tabular-nums text-amber-300 print:border-black/20 print:bg-transparent print:text-black">
                    {hop.status}
                  </span>
                  <span className="break-all text-white/50 print:text-black/70">{hop.from}</span>
                  <ArrowRight
                    size={12}
                    className="shrink-0 text-white/25 print:text-black/40"
                    aria-hidden="true"
                  />
                  <span className="break-all text-white/75 print:text-black">{hop.to}</span>
                </li>
              ))}
            </ol>
          </div>
        </section>
      ) : null}

      {/* -------------------------------------------------------- Top priority */}
      <section className="mt-12" aria-labelledby="audit-top-fixes">
        <Eyebrow>WHAT TO FIX FIRST</Eyebrow>
        <h2
          id="audit-top-fixes"
          className="mt-2 font-mono text-xl font-semibold tracking-tight text-white sm:text-2xl print:text-black"
        >
          Top priority fixes
        </h2>

        {topFixes.length === 0 ? (
          <div
            className={twMerge(
              CARD,
              "mt-4 flex items-center gap-3 border-emerald-400/20 bg-emerald-500/[0.04] p-5 print:border-black/15 print:bg-white",
            )}
          >
            <ShieldCheck
              size={20}
              className="shrink-0 text-emerald-400 print:text-black"
              aria-hidden="true"
            />
            <p className="text-sm leading-relaxed text-white/65 print:text-black/75">
              Nothing critical or warning-level came back. Everything below is either passing or an
              optional refinement.
            </p>
          </div>
        ) : (
          <>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/55 print:text-black/70">
              The {topFixes.length} highest-impact {topFixes.length === 1 ? "issue" : "issues"} across
              every category, weighted by how much each one costs you. Start here.
            </p>
            <ol className="mt-5 space-y-3">
              {topFixes.map(({ finding, categoryLabel }, i) => (
                <li key={finding.id} className="flex gap-3">
                  <span
                    className="mt-3 hidden w-5 shrink-0 text-right font-mono text-sm font-semibold tabular-nums text-white/20 sm:block print:text-black/40"
                    aria-hidden="true"
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-[#f5a524]/60 print:text-black/55">
                      {categoryLabel}
                    </h3>
                    <FindingRow finding={finding} />
                  </div>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>

      {/* ------------------------------------------------------------ Previews */}
      <PreviewCards preview={report.preview} finalUrl={report.finalUrl} />

      {/* ---------------------------------------------------- Full breakdown */}
      <section className="mt-12" aria-labelledby="audit-breakdown">
        <Eyebrow>EVERY CHECK</Eyebrow>
        <h2
          id="audit-breakdown"
          className="mt-2 flex flex-wrap items-baseline gap-x-3 font-mono text-xl font-semibold tracking-tight text-white sm:text-2xl print:text-black"
        >
          Full breakdown
          <span className="font-mono text-[11px] font-normal tracking-normal text-white/35 print:text-black/55">
            <Flame size={11} className="mr-1 inline align-baseline" aria-hidden="true" />
            categories with a critical issue open by default
          </span>
        </h2>

        <div className="mt-5 space-y-4">
          {categories.map((category) => (
            <CategoryPanel key={category.id} category={category} />
          ))}
        </div>
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Selection helpers                                                           */
/* -------------------------------------------------------------------------- */

/** CATEGORY_ORDER first, then anything the report carries that the order misses. */
function orderCategories(categories: CategoryResult[]): CategoryResult[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const ordered = CATEGORY_ORDER.map((id) => byId.get(id)).filter(
    (c): c is CategoryResult => c !== undefined,
  );
  const known = new Set<string>(CATEGORY_ORDER);
  const extras = categories.filter((c) => !known.has(c.id));
  return [...ordered, ...extras];
}

/**
 * The worst findings across the whole report: criticals before warnings, then
 * heaviest weight, then the more important category.
 */
function pickTopFixes(
  categories: CategoryResult[],
  limit: number,
): { finding: Finding; categoryLabel: string }[] {
  const pool = categories.flatMap((category) =>
    category.findings
      .filter((f) => f.severity === "critical" || f.severity === "warning")
      .map((finding) => ({ finding, category })),
  );

  pool.sort((a, b) => {
    if (a.finding.severity !== b.finding.severity) {
      return a.finding.severity === "critical" ? -1 : 1;
    }
    const weight = (b.finding.weight ?? 1) - (a.finding.weight ?? 1);
    if (weight !== 0) return weight;
    const categoryWeight = b.category.weight - a.category.weight;
    if (categoryWeight !== 0) return categoryWeight;
    return a.finding.title.localeCompare(b.finding.title);
  });

  return pool
    .slice(0, limit)
    .map(({ finding, category }) => ({ finding, categoryLabel: category.label }));
}
