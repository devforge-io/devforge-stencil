import { twMerge } from "tailwind-merge";
import type { Severity } from "~/lib/audit/types";

/**
 * The single source of truth for how severities look anywhere in the report.
 *
 * critical -> rose, warning -> amber, info -> sky, pass -> emerald.
 * Every audit component pulls its colours from here so nothing drifts.
 */
export const SEVERITY_STYLE: Record<
  Severity,
  { label: string; text: string; bg: string; border: string; dot: string }
> = {
  critical: {
    label: "Critical",
    text: "text-rose-300",
    bg: "bg-rose-500/10",
    border: "border-rose-500/30",
    dot: "bg-rose-400",
  },
  warning: {
    label: "Warning",
    text: "text-amber-300",
    bg: "bg-amber-500/10",
    border: "border-amber-500/30",
    dot: "bg-amber-400",
  },
  info: {
    label: "Info",
    text: "text-sky-300",
    bg: "bg-sky-500/10",
    border: "border-sky-500/30",
    dot: "bg-sky-400",
  },
  pass: {
    label: "Pass",
    text: "text-emerald-300",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/25",
    dot: "bg-emerald-400",
  },
};

/** Raw hex per severity, for SVG strokes / inline gradients where classes cannot reach. */
export const SEVERITY_HEX: Record<Severity, string> = {
  critical: "#fb7185",
  warning: "#fbbf24",
  info: "#38bdf8",
  pass: "#34d399",
};

/** Worst first. Use for sorting finding lists. */
export const SEVERITY_ORDER: Severity[] = ["critical", "warning", "info", "pass"];

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
  pass: 3,
};

/** "1 warning" / "3 warnings", with the odd ones spelled out properly. */
export function severityCountLabel(severity: Severity, count: number): string {
  switch (severity) {
    case "critical":
      return `${count} critical`;
    case "warning":
      return count === 1 ? "1 warning" : `${count} warnings`;
    case "info":
      return count === 1 ? "1 note" : `${count} notes`;
    case "pass":
      return `${count} passed`;
  }
}

/** Small pill with a leading dot. */
export function SeverityBadge({ severity }: { severity: Severity }) {
  const style = SEVERITY_STYLE[severity];

  return (
    <span
      className={twMerge(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em]",
        style.border,
        style.bg,
        style.text,
        "print:border-black/25 print:bg-transparent print:text-black",
      )}
    >
      <span
        className={twMerge("h-1.5 w-1.5 shrink-0 rounded-full", style.dot, "print:bg-black")}
        aria-hidden="true"
      />
      {style.label}
    </span>
  );
}
