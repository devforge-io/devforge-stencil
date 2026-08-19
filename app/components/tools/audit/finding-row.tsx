import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Copy, ExternalLink, Wrench } from "lucide-react";
import { twMerge } from "tailwind-merge";
import type { Finding } from "~/lib/audit/types";
import { SEVERITY_STYLE, SeverityBadge } from "./severity";

export function FindingRow({ finding }: { finding: Finding }) {
  const panelId = useId();
  const [open, setOpen] = useState(false);

  const hasDetail = Boolean(finding.fix || finding.snippet || finding.value || finding.docs);

  // Passes are reassurance, not work. One muted line, no disclosure.
  if (finding.severity === "pass") {
    return (
      <div className="flex items-start gap-2.5 rounded-lg px-3 py-2 print:px-0">
        <span
          className={twMerge(
            "mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full",
            SEVERITY_STYLE.pass.dot,
            "print:bg-black",
          )}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <h4 className="text-[13px] font-normal leading-relaxed text-white/45 print:text-black/60">
            <span className="sr-only">Passed: </span>
            {finding.title}
          </h4>
          {finding.value ? (
            <code className="mt-1 block break-words font-mono text-[11px] text-white/30 print:text-black/50">
              {finding.value}
            </code>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.02] transition-colors hover:border-white/20 print:break-inside-avoid print:border-black/15 print:bg-white print:hover:border-black/15">
      <div className="flex items-start gap-3 p-3.5">
        <div className="pt-0.5">
          <SeverityBadge severity={finding.severity} />
        </div>

        <div className="min-w-0 flex-1">
          <h4 className="font-mono text-sm font-medium leading-snug text-white print:text-black">
            {finding.title}
          </h4>
          <p className="mt-1.5 text-[13px] leading-relaxed text-white/55 print:text-black/70">
            {finding.detail}
          </p>
        </div>

        {hasDetail ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={panelId}
            className="-mr-1 flex shrink-0 items-center gap-1 rounded-lg border border-white/10 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-white/45 transition-colors hover:border-white/25 hover:text-white/75 print:hidden"
          >
            <span className="hidden sm:inline">{open ? "Hide" : "Fix"}</span>
            <ChevronDown
              size={13}
              aria-hidden="true"
              className={twMerge("transition-transform duration-200", open && "rotate-180")}
            />
            <span className="sr-only">
              {open ? "Hide details for" : "Show how to fix"} {finding.title}
            </span>
          </button>
        ) : null}
      </div>

      {hasDetail ? (
        <div
          id={panelId}
          className={twMerge(
            "border-t border-white/10 px-3.5 pb-3.5 pt-3 print:block print:border-black/10",
            open ? "block" : "hidden",
          )}
        >
          {finding.fix ? (
            <div className="flex items-start gap-2">
              <Wrench
                size={13}
                className="mt-[3px] shrink-0 text-[#f5a524]/70 print:text-black/50"
                aria-hidden="true"
              />
              <p className="text-[13px] leading-relaxed text-white/70 print:text-black/75">
                {finding.fix}
              </p>
            </div>
          ) : null}

          {finding.value ? (
            <div className="mt-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/40 print:text-black/50">
                Observed
              </div>
              <code className="mt-1.5 block max-h-40 overflow-y-auto overflow-x-auto break-words rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5 font-mono text-[12px] leading-relaxed text-[#ffcf5c]/85 print:border-black/15 print:bg-transparent print:text-black">
                {finding.value}
              </code>
            </div>
          ) : null}

          {finding.snippet ? (
            <div className="mt-3 overflow-hidden rounded-lg border border-white/10 bg-black/45 print:border-black/15 print:bg-transparent">
              <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-1.5 print:border-black/10">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/40 print:text-black/50">
                  Snippet
                </span>
                <CopyButton text={finding.snippet} />
              </div>
              <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[12px] leading-relaxed text-emerald-200/85 print:whitespace-pre-wrap print:text-black">
                <code>{finding.snippet}</code>
              </pre>
            </div>
          ) : null}

          {finding.docs ? (
            <a
              href={finding.docs}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-1.5 font-mono text-[11px] text-[#f5a524]/80 underline-offset-4 transition-colors hover:text-[#ffcf5c] hover:underline print:text-black/70"
            >
              Reference
              <ExternalLink size={12} aria-hidden="true" />
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return; // Insecure context or permission denied - fail quietly.
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className={twMerge(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors print:hidden",
        copied
          ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-300"
          : "border-white/10 text-white/45 hover:border-white/25 hover:text-white/80",
      )}
      aria-label={copied ? "Snippet copied to clipboard" : "Copy snippet to clipboard"}
    >
      {copied ? (
        <Check size={11} aria-hidden="true" />
      ) : (
        <Copy size={11} aria-hidden="true" />
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
