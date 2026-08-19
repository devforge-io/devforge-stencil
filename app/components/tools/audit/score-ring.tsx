import { useEffect, useState } from "react";
import { twMerge } from "tailwind-merge";

/** Stroke colour for a 0-100 score. Shared with the mini bars in the report. */
export function scoreColor(score: number): string {
  if (score >= 90) return "#34d399"; // emerald
  if (score >= 75) return "#a3e635"; // lime
  if (score >= 50) return "#fbbf24"; // amber
  if (score >= 25) return "#fb923c"; // orange
  return "#f43f5e"; // rose
}

/** Matching Tailwind text class, for score numbers rendered as text. */
export function scoreTextClass(score: number): string {
  if (score >= 90) return "text-emerald-300";
  if (score >= 75) return "text-lime-300";
  if (score >= 50) return "text-amber-300";
  if (score >= 25) return "text-orange-300";
  return "text-rose-300";
}

/* The donut geometry lives in a 100x100 viewBox so it scales with `size`. */
const STROKE = 9;
const RADIUS = (100 - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ScoreRing({
  score,
  size = 128,
  label,
}: {
  score: number;
  size?: number;
  label?: string;
}) {
  const target = Math.max(0, Math.min(100, Math.round(score)));
  const colour = scoreColor(target);

  // Sweep from empty to `target` once mounted. Reduced-motion users get the
  // same end state without the transition (see `motion-reduce:transition-none`).
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let inner = 0;
    const outer = window.requestAnimationFrame(() => {
      inner = window.requestAnimationFrame(() => setProgress(target));
    });
    return () => {
      window.cancelAnimationFrame(outer);
      window.cancelAnimationFrame(inner);
    };
  }, [target]);

  const offset = CIRCUMFERENCE * (1 - progress / 100);
  const numberSize = Math.max(14, Math.round(size * 0.3));
  const labelSize = Math.max(9, Math.round(size * 0.085));

  return (
    <div
      className="relative shrink-0 select-none"
      style={{ width: size, height: size }}
      role="img"
      aria-label={label ? `${label}: ${target} out of 100` : `Score ${target} out of 100`}
    >
      <svg
        viewBox="0 0 100 100"
        className="h-full w-full -rotate-90"
        aria-hidden="true"
        focusable="false"
      >
        <circle
          cx="50"
          cy="50"
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE}
          className="stroke-white/10 print:stroke-black/15"
        />
        <circle
          cx="50"
          cy="50"
          r={RADIUS}
          fill="none"
          stroke={colour}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
          className="transition-[stroke-dashoffset] duration-[1100ms] ease-out motion-reduce:transition-none"
          style={{ filter: `drop-shadow(0 0 6px ${colour}55)` }}
        />
      </svg>

      <div
        className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"
        aria-hidden="true"
      >
        <span
          className={twMerge(
            "font-mono font-semibold leading-none tracking-tight tabular-nums text-white print:text-black",
          )}
          style={{ fontSize: numberSize }}
        >
          {target}
        </span>
        {label ? (
          <span
            className="mt-1.5 max-w-[85%] text-center font-mono uppercase leading-tight tracking-[0.16em] text-white/45 print:text-black/60"
            style={{ fontSize: labelSize }}
          >
            {label}
          </span>
        ) : null}
      </div>
    </div>
  );
}
