import { Fragment, useEffect, useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { twMerge } from "tailwind-merge";
import type { CategoryResult, Finding } from "~/lib/audit/types";
import { FindingRow } from "./finding-row";
import { SEVERITY_ORDER, SEVERITY_RANK, SEVERITY_STYLE, severityCountLabel } from "./severity";
import { scoreColor, scoreTextClass } from "./score-ring";

/** DOM id for a category panel - the overview pills anchor to these. */
export function categoryAnchorId(id: string): string {
  return `category-${id}`;
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const rank = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (rank !== 0) return rank;
    const weight = (b.weight ?? 1) - (a.weight ?? 1);
    if (weight !== 0) return weight;
    return a.title.localeCompare(b.title);
  });
}

export function CategoryPanel({
  category,
  defaultOpen,
}: {
  category: CategoryResult;
  defaultOpen?: boolean;
}) {
  const anchorId = categoryAnchorId(category.id);
  const bodyId = useId();
  const [open, setOpen] = useState(defaultOpen ?? category.counts.critical > 0);

  // Deep links from the overview strip should reveal the panel they point at.
  useEffect(() => {
    const hash = `#${anchorId}`;
    const sync = () => {
      if (window.location.hash === hash) setOpen(true);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [anchorId]);

  const findings = sortFindings(category.findings);
  const actionable = findings.filter((f) => f.severity !== "pass");
  const passes = findings.filter((f) => f.severity === "pass");
  const colour = scoreColor(category.score);

  const parts = SEVERITY_ORDER.filter((s) => category.counts[s] > 0);

  return (
    <section
      id={anchorId}
      className="relative scroll-mt-24 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-xl print:break-inside-avoid print:border-black/15 print:bg-white print:backdrop-blur-none"
      style={{ boxShadow: "0 18px 48px rgba(0,0,0,0.35)" }}
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-px print:hidden"
        style={{
          background: `linear-gradient(90deg, transparent, ${colour}88, rgba(129,140,248,0.3), transparent)`,
        }}
      />

      <h3>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={bodyId}
          className="flex w-full items-start gap-4 px-5 py-4 text-left transition-colors hover:bg-white/[0.02] print:hover:bg-transparent"
        >
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-base font-semibold tracking-tight text-white print:text-black">
                {category.label}
              </span>
              <span
                className={twMerge(
                  "inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/30 px-2 py-0.5 font-mono text-[11px] tabular-nums print:border-black/20 print:bg-transparent print:text-black",
                  scoreTextClass(category.score),
                )}
              >
                {Math.round(category.score)}
                <span className="text-white/30 print:text-black/40">/100</span>
              </span>
            </span>

            <span className="mt-1 block text-[13px] leading-relaxed text-white/45 print:text-black/65">
              {category.blurb}
            </span>

            {parts.length > 0 ? (
              <span className="mt-2 flex flex-wrap items-center font-mono text-[11px]">
                {parts.map((severity, i) => (
                  <Fragment key={severity}>
                    {i > 0 ? (
                      <span className="mx-1.5 text-white/20 print:text-black/30" aria-hidden="true">
                        ·
                      </span>
                    ) : null}
                    <span
                      className={twMerge(
                        SEVERITY_STYLE[severity].text,
                        severity === "pass" && "text-white/35",
                        "print:text-black/60",
                      )}
                    >
                      {severityCountLabel(severity, category.counts[severity])}
                    </span>
                  </Fragment>
                ))}
              </span>
            ) : (
              <span className="mt-2 block font-mono text-[11px] text-white/30 print:text-black/50">
                No checks recorded
              </span>
            )}
          </span>

          <span className="mt-1 shrink-0 text-white/35 print:hidden" aria-hidden="true">
            <ChevronDown
              size={18}
              className={twMerge("transition-transform duration-200", open && "rotate-180")}
            />
          </span>
        </button>
      </h3>

      <div
        id={bodyId}
        className={twMerge(
          "border-t border-white/10 px-5 py-4 print:block print:border-black/10",
          open ? "block" : "hidden",
        )}
      >
        {findings.length === 0 ? (
          <p className="text-[13px] text-white/40 print:text-black/60">
            Nothing to report for this category.
          </p>
        ) : (
          <>
            {actionable.length > 0 ? (
              <ul className="space-y-2.5">
                {actionable.map((finding) => (
                  <li key={finding.id}>
                    <FindingRow finding={finding} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-emerald-300/80 print:text-black/70">
                Everything here checks out.
              </p>
            )}

            {passes.length > 0 ? (
              <div
                className={twMerge(
                  "mt-4 rounded-xl border border-white/5 bg-black/20 p-2 print:border-black/10 print:bg-transparent",
                  actionable.length === 0 && "mt-3",
                )}
              >
                <div className="px-1.5 pb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-white/30 print:text-black/50">
                  {severityCountLabel("pass", passes.length)}
                </div>
                <ul>
                  {passes.map((finding) => (
                    <li key={finding.id}>
                      <FindingRow finding={finding} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
