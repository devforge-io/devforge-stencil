/**
 * Shared page shell and small form primitives for the feature-requests tool.
 *
 * Same approach as the audit tool: the CMS header/footer and stylesheet come
 * from the content repo (site-chrome), the rest is Tailwind. Fork-local colours
 * are literal hex because this app's theme has no forge tokens.
 */

import type { ReactNode } from "react";
import { ArrowLeft, Lightbulb } from "lucide-react";
import type { SiteChrome } from "~/lib/site-chrome.server";
import { TailwindCdn } from "~/components/tailwind-cdn";

export const TOOL_PATH = "/tools/feature-requests";
export const ACCENT = "#f5a524";

export function molten(text: string) {
  return (
    <span
      style={{
        background: "linear-gradient(120deg, #ffcf5c, #f97316 55%, #ef4444)",
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        color: "transparent",
      }}
    >
      {text}
    </span>
  );
}

export function Shell({
  chrome,
  children,
  backHref = "/tools",
  backLabel = "All tools",
  eyebrow = "Feature requests",
  wide = false,
  nav,
}: {
  chrome: SiteChrome;
  children: ReactNode;
  backHref?: string;
  backLabel?: string;
  eyebrow?: string;
  wide?: boolean;
  nav?: ReactNode;
}) {
  return (
    <>
      <TailwindCdn />
      {chrome.css ? <style dangerouslySetInnerHTML={{ __html: chrome.css }} /> : null}
      <div className="min-h-screen bg-[#08060f] font-sans text-white antialiased">
        {chrome.headerHtml ? <div dangerouslySetInnerHTML={{ __html: chrome.headerHtml }} /> : null}
        <main>
          <div className="relative overflow-hidden px-5 pt-28 pb-24 sm:px-8">
            <div
              className="pointer-events-none absolute inset-0"
              style={{ background: "radial-gradient(110% 80% at 50% -10%, rgba(249,115,22,0.15) 0%, transparent 55%)" }}
            />
            <div className={`relative mx-auto ${wide ? "max-w-6xl" : "max-w-3xl"}`}>
              <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
                {/* Plain anchors: /tools is a CMS page served by the splat route. */}
                <a
                  href={backHref}
                  className="inline-flex w-fit items-center gap-1.5 font-mono text-xs text-white/45 transition-colors hover:text-[#f5a524]"
                >
                  <ArrowLeft size={14} aria-hidden="true" />
                  {backLabel}
                </a>
                {nav}
              </div>
              <div className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.24em] text-[#f5a524]/70">
                <Lightbulb size={13} aria-hidden="true" />
                {eyebrow}
              </div>
              {children}
            </div>
          </div>
        </main>
        {chrome.footerHtml ? <div dangerouslySetInnerHTML={{ __html: chrome.footerHtml }} /> : null}
      </div>
    </>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:p-6 ${className}`}>
      <span
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
        style={{ background: "linear-gradient(90deg, transparent, #f5a524, #ef4444, transparent)" }}
      />
      {children}
    </div>
  );
}

export const inputClass =
  "w-full rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-sm text-white outline-none transition-colors placeholder:text-white/30 focus:border-[#f5a524]/50 focus:bg-white/[0.05]";
export const labelClass = "mb-1.5 block font-mono text-[11px] uppercase tracking-[0.18em] text-white/45";
export const primaryBtn =
  "inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold text-[#1a0f00] transition-transform hover:-translate-y-0.5 disabled:opacity-60 disabled:hover:translate-y-0";
export const primaryBtnStyle = {
  background: "linear-gradient(120deg, #ffcf5c, #f97316 55%, #ef4444)",
  boxShadow: "0 8px 30px -10px rgba(249,115,22,0.6)",
};
export const ghostBtn =
  "inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-white/80 transition-colors hover:bg-white/[0.08] hover:text-white disabled:opacity-60";
export const dangerBtn =
  "inline-flex items-center justify-center gap-2 rounded-full border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-200 transition-colors hover:bg-red-500/20";

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className={labelClass}>
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1.5 text-xs text-white/40">{hint}</p> : null}
    </div>
  );
}

export function Notice({ kind = "error", children }: { kind?: "error" | "ok" | "info"; children: ReactNode }) {
  const styles =
    kind === "ok"
      ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
      : kind === "info"
        ? "border-[#f5a524]/30 bg-[#f5a524]/10 text-[#ffd98a]"
        : "border-red-400/30 bg-red-400/10 text-red-100";
  return <div className={`rounded-xl border px-3.5 py-2.5 text-sm ${styles}`}>{children}</div>;
}

export function StatusChip({ status }: { status: string }) {
  const map: Record<string, string> = {
    new: "border-white/15 bg-white/[0.04] text-white/60",
    planned: "border-sky-400/30 bg-sky-400/10 text-sky-200",
    in_progress: "border-[#f5a524]/40 bg-[#f5a524]/10 text-[#ffd98a]",
    done: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
    declined: "border-red-400/30 bg-red-400/10 text-red-200",
  };
  const label: Record<string, string> = { new: "New", planned: "Planned", in_progress: "In progress", done: "Done", declined: "Declined" };
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] ${map[status] ?? map.new}`}>
      {label[status] ?? status}
    </span>
  );
}

export function formatDate(ms: number): string {
  if (!ms) return "";
  try {
    return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}
