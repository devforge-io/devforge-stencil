/**
 * A licence key as the customer sees it: monospace, wraps anywhere, with a
 * copy button. Shared by the post-checkout page and /account/licenses.
 */

import { useState } from "react";
import { Check, Copy } from "lucide-react";

export function LicenseKey({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Selecting the text by hand still works.
    }
  }
  return (
    <div className="rounded-xl border border-white/10 bg-black/30">
      {label ? <div className="border-b border-white/10 px-3.5 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-white/45">{label}</div> : null}
      <div className="flex items-start gap-3 p-3.5">
        <code className="min-w-0 flex-1 select-all break-all font-mono text-[13px] leading-relaxed text-[#ffd98a]">{value}</code>
        <button
          type="button"
          onClick={copy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-white/75 transition-colors hover:bg-white/[0.08] hover:text-white"
          aria-label="Copy licence key"
        >
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
