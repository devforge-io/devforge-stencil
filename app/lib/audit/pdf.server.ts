/**
 * Renders an `AuditReport` as a typeset PDF document, published by Devforge.
 *
 * This is a *document*, not a screenshot of the web report: A4, real margins,
 * selectable text, vector artwork, and a footer on every page. It presents the
 * same information and the same priorities as `components/tools/audit/report.tsx`
 * and borrows that view's colour language for the parts that *mean* something
 * (rose / amber / sky / emerald for severities, emerald -> red for score bands),
 * darkened a step so it survives being printed on white paper.
 *
 * The document is bookended by two dark pages, and they are the only two. Page
 * 1 is a cover and nothing else: a full-bleed `DEVFORGE_COLOURS.ink` field
 * carrying the mark, the publisher and - given the largest type on the page -
 * the domain the report is about. The last page is its mirror, the same field
 * carrying the same mark at just over half the size, the byline, the link, what
 * was audited and when, and the note on what a static fetch cannot see. Neither
 * carries a footer: a page number on a cover reads as a mistake, and one on a
 * colophon reads as a document that stopped rather than ended. Everything
 * between them is the light document described above.
 *
 * The decorative chrome around that - the two dark pages, the eyebrows, the
 * masthead keyline - is Devforge's. The two vocabularies are kept strictly
 * apart: a severity hue only ever appears inside a chip, a dot, a snippet spine
 * or a count tally, and the Devforge ember only ever appears in an eyebrow, a
 * keyline or a link. Devforge orange and warning amber are close enough on paper
 * that letting them meet would cost the reader a beat of "is that a problem?",
 * so anything that would have sat next to a severity chip stays neutral grey.
 *
 * Two constraints shape everything below.
 *
 * 1. **Only the 14 standard PDF fonts.** Custom font files would need
 *    filesystem access at runtime, which does not survive a serverless deploy.
 *    Helvetica / Helvetica-Bold / Helvetica-Oblique / Courier only, which in
 *    turn means every string has to be folded into the WinAnsi repertoire
 *    before it reaches the page (see `sanitise`).
 *
 * 2. **Manual pagination.** Findings run from one line to twenty, so every
 *    block is measured with `heightOfString` and placed by hand. PDFKit's
 *    implicit page breaks are disabled outright (`height: NO_IMPLICIT_BREAK` on
 *    every draw) because they fire mid-block and desynchronise the `y` cursor
 *    this module tracks. Anything taller than a page is split into lines and
 *    flowed page by page with orphan/widow control instead.
 *
 * Pure module: no network, no filesystem, no environment. Report in, bytes out.
 */

import PDFDocument from "pdfkit";
import {
  DEVFORGE,
  DEVFORGE_COLOURS,
  DEVFORGE_LOGO,
  DEVFORGE_LOGO_SIZE,
} from "~/lib/audit/brand.server";
import { CATEGORY_META, CATEGORY_ORDER } from "~/lib/audit/types";
import type {
  AuditReport,
  CategoryId,
  CategoryResult,
  Finding,
  Grade,
  RedirectHop,
  Severity,
  SeverityCounts,
} from "~/lib/audit/types";

/* -------------------------------------------------------------------------- */
/* Page geometry                                                               */
/* -------------------------------------------------------------------------- */

/** A4 at 72dpi. */
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;

const MARGIN = { top: 54, bottom: 64, left: 54, right: 54 };

const CONTENT_LEFT = MARGIN.left;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN.left - MARGIN.right;
const CONTENT_TOP = MARGIN.top;
const CONTENT_BOTTOM = PAGE_HEIGHT - MARGIN.bottom;
const CONTENT_HEIGHT = CONTENT_BOTTOM - CONTENT_TOP;

/** Float slack when comparing a measured height against the remaining space. */
const EPSILON = 0.02;

/**
 * Passed as `height` on every `doc.text` call.
 *
 * PDFKit only auto-paginates when the wrapper's `maxY` is reached; handing it
 * an absurd ceiling disables that path entirely, so the cursor this module
 * tracks can never be moved behind its back.
 */
const NO_IMPLICIT_BREAK = 1e6;

const TOOL_URL = "https://purphoros.com/tools/website-audit";

/** Goes in `Creator` and `Producer`, and reads as a product name in Acrobat. */
const PRODUCER = `Devforge Website Audit (${DEVFORGE.displayUrl})`;

/* -------------------------------------------------------------------------- */
/* Palette                                                                     */
/* -------------------------------------------------------------------------- */

const INK = "#111827";
const INK_SOFT = "#374151";
const MUTED = "#6b7280";
const FAINT = "#9ca3af";
const HAIRLINE = "#e5e7eb";
const HAIRLINE_SOFT = "#eef0f2";
const PANEL_BG = "#f6f7f9";

/**
 * The Devforge accent, deepened for type.
 *
 * `DEVFORGE_COLOURS.ember` is a screen colour: 2.8:1 on white, which is fine
 * for a logo and hopeless for a 7pt letterspaced eyebrow. Darkening it to 5.2:1
 * puts it slightly *above* the rose it replaces (4.7:1) while keeping the hue
 * unmistakably molten, and lands it ~29 CIELAB units away from the warning
 * amber (`#d97706`) it must never be confused with.
 */
const ACCENT = "#c8380e";

interface SeverityStyle {
  /** Chip text. */
  label: string;
  /** Full-strength hue - dots, chip borders, rules. */
  color: string;
  /** Chip background. */
  tint: string;
  /** Darkened hue, legible as body text on white. */
  ink: string;
}

/** Same hues as `components/tools/audit/severity.tsx`, weighted for paper. */
const SEVERITY_STYLE: Record<Severity, SeverityStyle> = {
  critical: { label: "CRITICAL", color: "#e11d48", tint: "#fdeaef", ink: "#9f1239" },
  warning: { label: "WARNING", color: "#d97706", tint: "#fdf2e3", ink: "#92400e" },
  info: { label: "INFO", color: "#0284c7", tint: "#e8f3fb", ink: "#075985" },
  pass: { label: "PASS", color: "#059669", tint: "#e7f5f0", ink: "#065f46" },
};

const SEVERITY_ORDER: Severity[] = ["critical", "warning", "info", "pass"];

/** Arc / bar colour for a 0-100 score. Mirrors `scoreColor` in score-ring.tsx. */
function scoreColor(score: number): string {
  if (score >= 90) return "#10b981"; // emerald
  if (score >= 75) return "#84cc16"; // lime
  if (score >= 50) return "#f59e0b"; // amber
  if (score >= 25) return "#f97316"; // orange
  return "#ef4444"; // red
}

/** The same bands, darkened for score numerals set on white. */
function scoreInk(score: number): string {
  if (score >= 90) return "#047857";
  if (score >= 75) return "#4d7c0f";
  if (score >= 50) return "#b45309";
  if (score >= 25) return "#c2410c";
  return "#b91c1c";
}

/* -------------------------------------------------------------------------- */
/* Type scale                                                                  */
/* -------------------------------------------------------------------------- */

type FontName = "Helvetica" | "Helvetica-Bold" | "Helvetica-Oblique" | "Courier";

const BODY_SIZE = 9.4;
const BODY_GAP = 2.6;
const MONO_SIZE = 7.8;
const MONO_GAP = 1.6;

/* -------------------------------------------------------------------------- */
/* Truncation limits                                                           */
/* -------------------------------------------------------------------------- */

/*
 * Generous enough that a real finding is never clipped, tight enough that one
 * pathological field cannot turn a report into a 40-page appendix. `DETAIL_MAX`
 * is deliberately above a single page's worth of prose so the multi-page flow
 * path stays exercised rather than theoretical.
 */
const TITLE_MAX = 200;
const DETAIL_MAX = 6000;
const FIX_MAX = 4000;
const VALUE_MAX = 700;
const SNIPPET_MAX = 3000;
const SNIPPET_LINES_MAX = 24;
const URL_MAX = 300;
const DOCS_MAX = 160;
const TOP_FIXES = 8;

/* -------------------------------------------------------------------------- */
/* String hygiene                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Unicode code points WinAnsiEncoding carries at 0x80-0x9F.
 *
 * Everything else in the encoding is ASCII or Latin-1, which the two range
 * checks in `sanitise` cover.
 */
const WIN_ANSI_EXTRAS = new Set<number>([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
]);

function isRenderable(code: number): boolean {
  if (code >= 0x20 && code <= 0x7e) return true;
  if (code >= 0xa0 && code <= 0xff) return true;
  return WIN_ANSI_EXTRAS.has(code);
}

/**
 * Characters that carry real meaning in technical prose but are not in WinAnsi.
 *
 * Audit findings quote redirect chains and comparisons constantly, so `→`
 * turning into `?` would be a visible loss. Everything here degrades to an
 * ASCII equivalent that reads the same way out loud.
 */
const TRANSLITERATE: Record<string, string> = {
  "\u00a0": " ", // nbsp - renderable, but it would defeat line breaking
  "\u2007": " ",
  "\u202f": " ",
  "\u200b": "", // zero-width space, joiners and BOM
  "\u200c": "",
  "\u200d": "",
  "\ufeff": "",
  "\u2011": "-", // non-breaking hyphen
  "\u2212": "-", // minus sign
  "\u2192": "->",
  "\u2190": "<-",
  "\u2194": "<->",
  "\u21d2": "=>",
  "\u21d0": "<=",
  "\u2264": "<=",
  "\u2265": ">=",
  "\u2260": "!=",
  "\u2248": "~",
  "\u2032": "'",
  "\u2033": '"',
  "\u2713": "OK",
  "\u2714": "OK",
  "\u2717": "x",
  "\u2718": "x",
  "\u26a0": "!",
  "\u2605": "*",
  "\u2606": "*",
  "\u03bc": "\u00b5", // Greek mu -> micro sign
};

/**
 * Folds arbitrary text into something the standard fonts can actually draw.
 *
 * Control characters go, tabs become spaces, and anything outside WinAnsi -
 * CJK, emoji, unpaired surrogates - collapses to a single `?` per run rather
 * than a wall of replacement glyphs. `keepBreaks` is only set for snippets,
 * where line structure is the point.
 */
function sanitise(input: string, keepBreaks: boolean): string {
  let out = "";
  let pendingUnknown = false;
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    if (keepBreaks && (code === 0x0a || code === 0x0d)) {
      // Normalise CRLF/CR to a single newline.
      if (code === 0x0d) continue;
      out += "\n";
      pendingUnknown = false;
      continue;
    }
    if (code === 0x09) {
      out += "  ";
      pendingUnknown = false;
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      // Control character: swallow it, but keep words apart.
      if (out.length > 0 && !out.endsWith(" ") && !out.endsWith("\n")) out += " ";
      pendingUnknown = false;
      continue;
    }
    // Transliteration runs before the encoding check on purpose: a no-break
    // space is perfectly renderable but would glue a line together.
    const swap = TRANSLITERATE[char];
    if (swap !== undefined) {
      out += swap;
      pendingUnknown = false;
      continue;
    }
    if (isRenderable(code)) {
      out += char;
      pendingUnknown = false;
      continue;
    }
    if (!pendingUnknown) {
      out += "?";
      pendingUnknown = true;
    }
  }
  return out;
}

/** Sanitised, whitespace-collapsed, length-capped prose. Empty when absent. */
function prose(value: string | null | undefined, max: number): string {
  if (typeof value !== "string" || value.length === 0) return "";
  // Cap before sanitising so a megabyte of junk is never walked character by
  // character; the slack covers multi-byte input shrinking under sanitisation.
  const capped = value.length > max * 4 ? value.slice(0, max * 4) : value;
  const cleaned = sanitise(capped, false).replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  // Drop trailing punctuation so the cut does not read as ".…".
  const head = cleaned.slice(0, Math.max(1, max - 1)).replace(/[\s.,;:!?-]+$/, "");
  return `${head}…`;
}

/** Sanitised text that keeps its line structure. Used for snippets. */
function block(value: string | null | undefined, max: number, maxLines: number): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  const capped = value.length > max * 4 ? value.slice(0, max * 4) : value;
  let cleaned = sanitise(capped, true).replace(/[ \t]+$/gm, "");
  if (cleaned.length > max) cleaned = `${cleaned.slice(0, max)}…`;
  const lines = cleaned.split("\n");
  // Drop leading and trailing blank lines - they are almost always artefacts.
  while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept.push(`… ${lines.length - maxLines} more line${lines.length - maxLines === 1 ? "" : "s"}`);
  return kept;
}

/* -------------------------------------------------------------------------- */
/* Number and date formatting                                                  */
/* -------------------------------------------------------------------------- */

function finite(value: number | null | undefined, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampScore(value: number | null | undefined): number {
  return Math.max(0, Math.min(100, Math.round(finite(value, 0))));
}

function formatBytes(bytes: number): string {
  const n = finite(bytes, 0);
  if (n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatNumber(value: number): string {
  return Math.round(finite(value, 0))
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatMs(ms: number): string {
  const n = finite(ms, Number.NaN);
  if (!Number.isFinite(n) || n < 0) return "-";
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

function parseDate(iso: string | null | undefined): Date | null {
  if (typeof iso !== "string" || iso.length === 0) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `2026-08-18 09:40 UTC`, formatted by hand so it never drifts with a locale. */
function formatTimestamp(iso: string | null | undefined): string {
  const date = parseDate(iso);
  if (!date) return "date unavailable";
  const pad = (n: number): string => String(n).padStart(2, "0");
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

/** "1 warning" / "3 warnings", matching `severityCountLabel` in the web report. */
function severityCountLabel(severity: Severity, count: number): string {
  const n = Math.max(0, Math.round(finite(count, 0)));
  switch (severity) {
    case "critical":
      return `${n} critical`;
    case "warning":
      return n === 1 ? "1 warning" : `${n} warnings`;
    case "info":
      return n === 1 ? "1 note" : `${n} notes`;
    case "pass":
      return `${n} passed`;
  }
}

function hostOf(url: string | null | undefined): string {
  if (typeof url !== "string" || url.length === 0) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/* -------------------------------------------------------------------------- */
/* Filename                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `website-audit-purphoros-com-2026-08-18.pdf`.
 *
 * This lands in a `Content-Disposition` header, so the output is restricted to
 * `[a-z0-9-]` by construction: no separators, no quotes, no semicolons, no
 * newlines, nothing that could terminate the header value early.
 */
export function auditPdfFilename(report: AuditReport): string {
  const host = hostOf(report?.finalUrl) || hostOf(report?.requestedUrl);
  const slug =
    host
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64)
      .replace(/-+$/, "") || "site";

  const date = parseDate(report?.fetchedAt);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp = date
    ? `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    : "undated";

  return `website-audit-${slug}-${stamp}.pdf`;
}

/* -------------------------------------------------------------------------- */
/* Layout engine                                                               */
/* -------------------------------------------------------------------------- */

interface TextStyle {
  font: FontName;
  size: number;
  color: string;
  lineGap?: number;
  characterSpacing?: number;
  align?: "left" | "right" | "center";
  link?: string;
}

/**
 * A cursor over a stack of pages.
 *
 * Every method that emits ink goes through here so that exactly one thing owns
 * the vertical position. `measure` -> `fits` -> `draw` is the only sequence;
 * nothing ever draws speculatively and then reacts to a page break.
 */
class Layout {
  readonly doc: PDFKit.PDFDocument;
  y = CONTENT_TOP;

  constructor(doc: PDFKit.PDFDocument) {
    this.doc = doc;
  }

  /* --- page management --- */

  newPage(): void {
    this.doc.addPage();
    this.y = CONTENT_TOP;
  }

  get remaining(): number {
    return CONTENT_BOTTOM - this.y;
  }

  get atPageTop(): boolean {
    return this.y <= CONTENT_TOP + EPSILON;
  }

  fits(height: number): boolean {
    return height <= this.remaining + EPSILON;
  }

  /** Break to a new page unless `height` still fits on this one. */
  keep(height: number): void {
    if (!this.fits(height) && !this.atPageTop) this.newPage();
  }

  gap(height: number): void {
    // Never carry whitespace onto a fresh page.
    if (this.atPageTop) return;
    this.y = Math.min(this.y + height, CONTENT_BOTTOM);
  }

  /* --- font plumbing --- */

  private apply(style: TextStyle): void {
    this.doc.font(style.font).fontSize(style.size).fillColor(style.color);
  }

  lineHeight(style: TextStyle): number {
    this.apply(style);
    return this.doc.currentLineHeight(true) + (style.lineGap ?? 0);
  }

  widthOf(text: string, style: TextStyle): number {
    this.apply(style);
    return this.doc.widthOfString(text, { characterSpacing: style.characterSpacing });
  }

  /* --- measurement --- */

  /**
   * Height of `text` laid out in `width`, using the exact options the draw call
   * will use so the two can never disagree.
   */
  measure(text: string, width: number, style: TextStyle): number {
    if (text.length === 0) return 0;
    this.apply(style);
    return this.doc.heightOfString(text, {
      width,
      lineGap: style.lineGap ?? 0,
      characterSpacing: style.characterSpacing,
      align: style.align,
    });
  }

  /**
   * Inserts hard breaks inside any token wider than the column.
   *
   * PDFKit only breaks at spaces and hyphens, so a 300-character URL or a
   * base64 blob would otherwise sail straight off the right edge. Feeding it
   * pre-broken text means both `heightOfString` and `text` see the same string.
   */
  fitTokens(text: string, width: number, style: TextStyle): string {
    if (text.length === 0) return "";
    this.apply(style);
    const limit = Math.max(4, width - 0.5);
    const parts: string[] = [];
    for (const token of text.split(" ")) {
      if (token.length === 0) continue;
      if (this.doc.widthOfString(token, { characterSpacing: style.characterSpacing }) <= limit) {
        parts.push(token);
        continue;
      }
      parts.push(this.chop(token, limit, style).join("\n"));
    }
    return parts.join(" ");
  }

  /** Splits one over-long token into the widest pieces that fit `width`. */
  chop(token: string, width: number, style: TextStyle): string[] {
    this.apply(style);
    const spacing = { characterSpacing: style.characterSpacing };
    const pieces: string[] = [];
    let start = 0;
    while (start < token.length) {
      let low = 1;
      let high = token.length - start;
      let best = 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (this.doc.widthOfString(token.slice(start, start + mid), spacing) <= width) {
          best = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      pieces.push(token.slice(start, start + best));
      start += best;
    }
    return pieces;
  }

  /** Greedy line breaking that mirrors what PDFKit will do with the same text. */
  private wrapToLines(text: string, width: number, style: TextStyle): string[] {
    this.apply(style);
    const spacing = { characterSpacing: style.characterSpacing };
    const limit = Math.max(4, width - 0.5);
    const lines: string[] = [];
    for (const segment of text.split("\n")) {
      let current = "";
      for (const word of segment.split(" ")) {
        if (word.length === 0) continue;
        const candidate = current.length === 0 ? word : `${current} ${word}`;
        if (current.length === 0 || this.doc.widthOfString(candidate, spacing) <= limit) {
          current = candidate;
        } else {
          lines.push(current);
          current = word;
        }
      }
      if (current.length > 0) lines.push(current);
    }
    return lines;
  }

  /* --- drawing --- */

  /** Raw emit at an absolute position. Never moves the cursor. */
  private emit(text: string, x: number, y: number, width: number, style: TextStyle): void {
    this.apply(style);
    this.doc.text(text, x, y, {
      width,
      height: NO_IMPLICIT_BREAK,
      lineGap: style.lineGap ?? 0,
      characterSpacing: style.characterSpacing,
      align: style.align,
      link: style.link,
    });
  }

  /**
   * A paragraph that is never split.
   *
   * Use for headings and anything short enough that a break inside it would
   * read as a mistake. Falls back to `flow` if the text somehow exceeds a page.
   */
  paragraph(text: string, x: number, width: number, style: TextStyle): void {
    const fitted = this.fitTokens(text, width, style);
    if (fitted.length === 0) return;
    const height = this.measure(fitted, width, style);
    if (height > CONTENT_HEIGHT) {
      this.flow(fitted, x, width, style);
      return;
    }
    this.keep(height);
    this.emit(fitted, x, this.y, width, style);
    this.y += height;
  }

  /**
   * A paragraph that may cross a page boundary, with orphan/widow control.
   *
   * Splitting happens in this module rather than in PDFKit: the text is broken
   * into lines, and each page takes as many as it can hold, never leaving a
   * single line stranded at the foot of a page or carried alone to the next.
   */
  flow(text: string, x: number, width: number, style: TextStyle): void {
    const fitted = this.fitTokens(text, width, style);
    if (fitted.length === 0) return;

    const height = this.measure(fitted, width, style);
    if (this.fits(height)) {
      this.emit(fitted, x, this.y, width, style);
      this.y += height;
      return;
    }

    const lineHeight = this.lineHeight(style);
    if (lineHeight <= 0) return;
    const lines = this.wrapToLines(fitted, width, style);
    const perPage = Math.max(1, Math.floor((CONTENT_HEIGHT + EPSILON) / lineHeight));

    let index = 0;
    while (index < lines.length) {
      let capacity = Math.floor((this.remaining + EPSILON) / lineHeight);
      if (capacity < 1) {
        this.newPage();
        capacity = perPage;
      }
      let take = Math.min(capacity, lines.length - index);
      // Do not carry a lone final line onto the next page.
      if (lines.length - index - take === 1 && take > 1) take -= 1;
      // Do not strand a lone first line at the foot of this page.
      if (take === 1 && lines.length - index > 1 && !this.atPageTop) {
        this.newPage();
        continue;
      }
      const chunk = lines.slice(index, index + take).join("\n");
      this.emit(chunk, x, this.y, width, style);
      this.y += take * lineHeight;
      index += take;
      if (index < lines.length) this.newPage();
    }
  }

  /** A single line, clipped with an ellipsis rather than wrapped. */
  line(text: string, x: number, width: number, style: TextStyle): void {
    if (text.length === 0) return;
    const height = this.lineHeight(style);
    this.keep(height);
    this.emit(this.ellipsise(text, width, style), x, this.y, width, style);
    this.y += height;
  }

  /** Truncates to `width` with a trailing ellipsis. No cursor movement. */
  ellipsise(text: string, width: number, style: TextStyle): string {
    this.apply(style);
    const spacing = { characterSpacing: style.characterSpacing };
    if (this.doc.widthOfString(text, spacing) <= width) return text;
    const pieces = this.chop(text, Math.max(4, width - this.doc.widthOfString("…", spacing)), style);
    return `${pieces[0] ?? ""}…`;
  }

  /** Draws at an absolute position without touching the cursor. */
  at(text: string, x: number, y: number, width: number, style: TextStyle): void {
    if (text.length === 0) return;
    this.emit(text, x, y, width, style);
  }

  rule(x: number, width: number, color: string = HAIRLINE, thickness = 0.5): void {
    // A separator that lands at the very top of a fresh page separates nothing.
    if (this.atPageTop) return;
    this.keep(thickness);
    this.doc
      .save()
      .lineWidth(thickness)
      .strokeColor(color)
      .moveTo(x, this.y + thickness / 2)
      .lineTo(x + width, this.y + thickness / 2)
      .stroke()
      .restore();
    this.y += thickness;
  }
}

/* -------------------------------------------------------------------------- */
/* The logo                                                                    */
/* -------------------------------------------------------------------------- */

/*
 * The anvil-and-gear emblem stacked above the DEVFORGE wordmark: 340x251, so
 * very nearly a square rather than the wide strip a lockup usually is. On a
 * light page that shape is expensive, which is why the mark appears exactly
 * twice, and on neither of the light pages: large on the cover, where a stacked
 * block is the whole point, and again on the dark back page, signing off.
 *
 * 216pt is the cover width: the wordmark runs the full measure of the asset, so
 * this is 44% of the text column, wide enough to own the page while still
 * leaving the domain beneath it room to be the wider line. It is a reduction
 * rather than an enlargement (340px over 216pt is ~113 effective dpi), and the
 * artwork is a soft rendered emblem rather than hairline vector work, so it
 * holds up.
 *
 * 120pt on the back page is 56% of that. Deliberately not a near-miss: at, say,
 * 190pt the two marks would read as the same size drawn slightly wrong, whereas
 * a little over half is unambiguously a smaller restatement. It is still a
 * full-page mark rather than a signature - the closing page has nothing else
 * large on it - so it holds the top of that composition the way the cover's
 * holds the top of its own. Only `width` is ever passed, so PDFKit derives the
 * height from the image's own dimensions and the mark can never be stretched.
 */
const COVER_LOGO_WIDTH = 216;
const BACK_LOGO_WIDTH = 120;

function logoHeight(width: number): number {
  return (width * DEVFORGE_LOGO_SIZE.height) / DEVFORGE_LOGO_SIZE.width;
}

/**
 * A handle to the logo already embedded in one document.
 *
 * PDFKit only de-duplicates images whose source is a *string* path, so handing
 * `doc.image` the same `Buffer` twice writes the PNG into the file twice. That
 * is expensive here: the source is a 35 KB palette PNG, but PDFKit expands the
 * palette into a raw RGB stream and turns the `tRNS` chunk into a full soft
 * mask, so each embed costs about 61 KB. `doc.openImage` returns the embedded
 * object, and `doc.image` accepts it back (`if (src.width && src.height) image
 * = src`), so the bytes land once and both draws share them. Neither entry
 * point is in `@types/pdfkit`, hence the two narrow structural casts; both are
 * checked against the shape they promise before anything is drawn, and the
 * whole thing degrades to a plain Buffer draw if a future PDFKit stops
 * obliging.
 */
interface Logo {
  readonly width: number;
  readonly height: number;
}

function openLogo(doc: PDFKit.PDFDocument): Logo | null {
  const opener = doc as unknown as { openImage?: (src: Buffer) => unknown };
  if (typeof opener.openImage !== "function") return null;
  try {
    const opened = opener.openImage(DEVFORGE_LOGO);
    if (opened === null || typeof opened !== "object") return null;
    // The instance itself is handed back, never a copy: PDFKit recognises an
    // already-embedded image by its own `embed`/`obj` fields, not by shape.
    const candidate = opened as Logo;
    if (typeof candidate.width !== "number" || typeof candidate.height !== "number") return null;
    return candidate;
  } catch {
    return null;
  }
}

/** Draws the logo at an absolute position. Returns the height it occupies. */
function drawLogo(
  doc: PDFKit.PDFDocument,
  logo: Logo | null,
  x: number,
  y: number,
  width: number,
): number {
  if (logo === null) {
    doc.image(DEVFORGE_LOGO, x, y, { width });
  } else {
    const drawer = doc as unknown as {
      image(src: Logo, x: number, y: number, options: { width: number }): void;
    };
    drawer.image(logo, x, y, { width });
  }
  return logoHeight(width);
}

/* -------------------------------------------------------------------------- */
/* Vector artwork                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Traces a circular arc as cubic beziers.
 *
 * PDF has no arc primitive, and leaning on PDFKit's SVG path parser for an `A`
 * command is more indirection than four lines of trigonometry deserve. Angles
 * are radians, clockwise on screen (PDFKit's y axis points down).
 */
function arcPath(
  doc: PDFKit.PDFDocument,
  cx: number,
  cy: number,
  radius: number,
  from: number,
  to: number,
): void {
  const sweep = to - from;
  const segments = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
  const step = sweep / segments;
  const handle = (4 / 3) * Math.tan(step / 4) * radius;

  let angle = from;
  doc.moveTo(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
  for (let i = 0; i < segments; i += 1) {
    const next = angle + step;
    const x1 = cx + radius * Math.cos(angle);
    const y1 = cy + radius * Math.sin(angle);
    const x2 = cx + radius * Math.cos(next);
    const y2 = cy + radius * Math.sin(next);
    doc.bezierCurveTo(
      x1 - handle * Math.sin(angle),
      y1 + handle * Math.cos(angle),
      x2 + handle * Math.sin(next),
      y2 - handle * Math.cos(next),
      x2,
      y2,
    );
    angle = next;
  }
}

/** The overall-score donut: a track ring plus a coloured arc, all vector. */
function drawScoreDonut(
  layout: Layout,
  cx: number,
  cy: number,
  radius: number,
  thickness: number,
  score: number,
  grade: Grade,
): void {
  const doc = layout.doc;
  const value = clampScore(score);
  const colour = scoreColor(value);

  doc.save();
  doc.lineWidth(thickness);
  doc.circle(cx, cy, radius).strokeColor("#e8eaee").stroke();
  if (value > 0) {
    const start = -Math.PI / 2;
    doc.lineCap("round");
    arcPath(doc, cx, cy, radius, start, start + (value / 100) * Math.PI * 2);
    doc.strokeColor(colour).stroke();
  }
  doc.restore();

  const numberStyle: TextStyle = { font: "Helvetica-Bold", size: 30, color: INK, align: "center" };
  const numberHeight = layout.lineHeight(numberStyle);
  layout.at(String(value), cx - radius, cy - numberHeight * 0.62, radius * 2, numberStyle);

  layout.at("OUT OF 100", cx - radius, cy + numberHeight * 0.42, radius * 2, {
    font: "Helvetica",
    size: 6.4,
    color: FAINT,
    align: "center",
    characterSpacing: 1.1,
  });

  const gradeLabel = typeof grade === "string" && grade.length > 0 ? sanitise(grade, false) : "-";
  layout.at(`GRADE ${gradeLabel}`, cx - radius, cy + radius + 12, radius * 2, {
    font: "Helvetica-Bold",
    size: 8.2,
    color: scoreInk(value),
    align: "center",
    characterSpacing: 1.6,
  });
}

/* -------------------------------------------------------------------------- */
/* Chips and small parts                                                       */
/* -------------------------------------------------------------------------- */

const CHIP_HEIGHT = 11.5;
const CHIP_FONT: TextStyle = {
  font: "Helvetica-Bold",
  size: 6.2,
  color: INK,
  characterSpacing: 0.9,
};

function chipWidth(layout: Layout, label: string): number {
  return layout.widthOf(label, CHIP_FONT) + 18;
}

/** Dot + label pill. Returns its width so callers can lay out a row. */
function drawChip(layout: Layout, x: number, y: number, severity: Severity, count?: number): number {
  const style = SEVERITY_STYLE[severity];
  const label = count === undefined ? style.label : severityCountLabel(severity, count).toUpperCase();
  const width = chipWidth(layout, label);
  const doc = layout.doc;

  doc.save();
  doc.roundedRect(x, y, width, CHIP_HEIGHT, CHIP_HEIGHT / 2).fill(style.tint);
  doc
    .lineWidth(0.5)
    .roundedRect(x, y, width, CHIP_HEIGHT, CHIP_HEIGHT / 2)
    .strokeColor(style.color)
    .stroke();
  doc.circle(x + 6.5, y + CHIP_HEIGHT / 2, 1.9).fill(style.color);
  doc.restore();

  const textStyle: TextStyle = { ...CHIP_FONT, color: style.ink };
  const textHeight = layout.lineHeight(textStyle);
  layout.at(label, x + 11.5, y + (CHIP_HEIGHT - textHeight) / 2 + 0.3, width, textStyle);

  return width;
}

/** Rounded progress bar. Used for category scores. */
function drawScoreBar(layout: Layout, x: number, y: number, width: number, score: number): void {
  const value = clampScore(score);
  const doc = layout.doc;
  const height = 3;
  doc.save();
  doc.roundedRect(x, y, width, height, height / 2).fill(HAIRLINE);
  const filled = Math.max(height, (width * Math.max(value, 1.5)) / 100);
  doc.roundedRect(x, y, filled, height, height / 2).fill(scoreColor(value));
  doc.restore();
}

/* -------------------------------------------------------------------------- */
/* Section furniture                                                           */
/* -------------------------------------------------------------------------- */

const EYEBROW: TextStyle = {
  font: "Helvetica-Bold",
  size: 7,
  color: ACCENT,
  characterSpacing: 1.9,
};

const H2: TextStyle = { font: "Helvetica-Bold", size: 16, color: INK };
const LEAD: TextStyle = { font: "Helvetica", size: BODY_SIZE, color: MUTED, lineGap: BODY_GAP };
const BODY: TextStyle = { font: "Helvetica", size: BODY_SIZE, color: INK_SOFT, lineGap: BODY_GAP };

function sectionHeading(layout: Layout, eyebrow: string, title: string, lead?: string): void {
  const eyebrowHeight = layout.lineHeight(EYEBROW);
  const titleHeight = layout.measure(title, CONTENT_WIDTH, H2);
  const leadHeight = lead ? layout.measure(lead, CONTENT_WIDTH * 0.82, LEAD) : 0;
  // Never leave a heading stranded: it has to bring its lead paragraph and a
  // meaningful slice of whatever follows - roughly a category header block or
  // the head of a finding - onto the same page with it.
  layout.keep(eyebrowHeight + 5 + titleHeight + leadHeight + 90);

  layout.paragraph(eyebrow, CONTENT_LEFT, CONTENT_WIDTH, EYEBROW);
  layout.gap(4);
  layout.paragraph(title, CONTENT_LEFT, CONTENT_WIDTH, H2);
  if (lead) {
    layout.gap(5);
    layout.paragraph(lead, CONTENT_LEFT, CONTENT_WIDTH * 0.82, LEAD);
  }
  layout.gap(12);
}

/* -------------------------------------------------------------------------- */
/* Cover                                                                       */
/* -------------------------------------------------------------------------- */

/*
 * Colour on near-black.
 *
 * `ink` is `#08060f`, so almost everything clears 7:1 without trying. The one
 * thing worth being careful about is not reaching for `#ffffff`: pure white on
 * near-black is 21:1 and visibly vibrates at display sizes. `COVER_TEXT` is a
 * hair off it - 16.8:1, and tinted toward `DEVFORGE_COLOURS.inkSoft` so it sits
 * in the same cool family as the chrome in the wordmark.
 *
 * The ember is the real prize here. `DEVFORGE_COLOURS.ember` is 2.8:1 on white,
 * which is why the body of this document has to use a darkened `ACCENT`
 * instead; on `ink` the same hue is 7.3:1. This is the only page where the
 * brand colour can be used at full strength as type, so the link uses it.
 */
const COVER_TEXT = "#efeaf5";
const COVER_QUIET = "#a49bb4";
const COVER_EMBER = DEVFORGE_COLOURS.ember;

/** The domain sets as large as it can inside this, then shrinks to fit. */
const COVER_MEASURE = CONTENT_WIDTH * 0.94;
const COVER_DOMAIN_MAX = 38;
const COVER_DOMAIN_MIN = 13;

/**
 * How far above true vertical centre the block sits.
 *
 * A block centred on the arithmetic middle of a page always looks like it has
 * sagged, because the eye reads the centre of a rectangle as being above the
 * measured one. 20pt puts the block at roughly 46% of the page height, which
 * corrects for that; going further starts to read as a top-aligned composition
 * with a hole under it rather than as a centred one.
 */
const COVER_OPTICAL_RISE = 20;

/** The one thing the cover is about. Never empty. */
function coverSubject(report: AuditReport): { text: string; known: boolean } {
  const host = prose(hostOf(report?.finalUrl) || hostOf(report?.requestedUrl), 120);
  if (host.length > 0) return { text: host, known: true };
  // No parseable host: fall back to whatever URL-ish string the report carries
  // rather than leaving the cover's headline blank.
  const raw = prose(report?.finalUrl, 120) || prose(report?.requestedUrl, 120);
  if (raw.length > 0) return { text: raw, known: true };
  return { text: "URL not recorded", known: false };
}

/** Largest size at or below `max` that sets `text` on one line inside `width`. */
function fitOneLine(layout: Layout, text: string, width: number, style: TextStyle): number {
  let size = COVER_DOMAIN_MAX;
  while (size > COVER_DOMAIN_MIN && layout.widthOf(text, { ...style, size }) > width) {
    size -= 0.5;
  }
  return size;
}

/**
 * Page 1: dark, centred, and carrying four lines and a mark.
 *
 * The dark field is laid down before anything else and covers the MediaBox
 * rather than the content box, margins included, so there is no white border
 * and no seam where a fill stopped short of an edge.
 *
 * Composition is a single block, measured whole and then placed, so the gaps
 * between its parts are the only thing that has to be tuned. Reading down: the
 * mark, large, because this is the one place in the document where it can
 * breathe and the artwork was drawn for a dark ground. Then the publisher, two
 * quiet lines at ~9pt. Then a 54pt hole - by far the largest gap on the page,
 * and the thing that separates who made this from what it is about. Then the
 * kicker, and then the domain at up to 38pt.
 *
 * `COVER_TEXT` is spent on exactly one line, the domain. Everything else is
 * either the muted grey or the ember, so the brightest thing on the page after
 * the mark itself is the subject, and the hierarchy holds even at thumbnail
 * size. The ember is spent on the link and nowhere else: letting it carry the
 * domain too would have put the most important line in the same colour as the
 * "FORGE" half of the wordmark directly above it, and the two would have
 * started competing.
 */
function drawCover(layout: Layout, report: AuditReport, logo: Logo | null): void {
  const doc = layout.doc;

  // Full bleed, before any other ink on this page.
  doc.save().rect(0, 0, doc.page.width, doc.page.height).fill(DEVFORGE_COLOURS.ink).restore();

  const subject = coverSubject(report);

  const companyStyle: TextStyle = {
    font: "Helvetica-Bold",
    size: 9.2,
    color: COVER_QUIET,
    align: "center",
    characterSpacing: 1.7,
  };
  const urlStyle: TextStyle = {
    font: "Helvetica",
    size: 8.8,
    color: COVER_EMBER,
    align: "center",
    characterSpacing: 0.7,
    link: DEVFORGE.url,
  };
  const kickerStyle: TextStyle = {
    font: "Helvetica-Bold",
    size: 8,
    color: COVER_QUIET,
    align: "center",
    characterSpacing: 3.6,
  };
  const domainStyle: TextStyle = {
    font: "Helvetica-Bold",
    size: fitOneLine(layout, subject.text, COVER_MEASURE, {
      font: "Helvetica-Bold",
      size: COVER_DOMAIN_MAX,
      color: COVER_TEXT,
    }),
    // An absent URL is an absence, not a subject, so it does not get the
    // headline colour.
    color: subject.known ? COVER_TEXT : COVER_QUIET,
    align: "center",
  };
  // Only bites if a host is longer than the smallest size still fits.
  const domainText = layout.ellipsise(subject.text, COVER_MEASURE, domainStyle);

  const markHeight = logoHeight(COVER_LOGO_WIDTH);
  const companyHeight = layout.lineHeight(companyStyle);
  const urlHeight = layout.lineHeight(urlStyle);
  const kickerHeight = layout.lineHeight(kickerStyle);
  const domainHeight = layout.lineHeight(domainStyle);

  const blockHeight =
    markHeight + 34 + companyHeight + 4 + urlHeight + 54 + kickerHeight + 12 + domainHeight;

  let y = (PAGE_HEIGHT - blockHeight) / 2 - COVER_OPTICAL_RISE;

  drawLogo(doc, logo, (PAGE_WIDTH - COVER_LOGO_WIDTH) / 2, y, COVER_LOGO_WIDTH);
  y += markHeight + 34;

  layout.at(DEVFORGE.company, CONTENT_LEFT, y, CONTENT_WIDTH, companyStyle);
  y += companyHeight + 4;

  layout.at(DEVFORGE.url, CONTENT_LEFT, y, CONTENT_WIDTH, urlStyle);
  y += urlHeight + 54;

  layout.at("WEBSITE AUDIT REPORT", CONTENT_LEFT, y, CONTENT_WIDTH, kickerStyle);
  y += kickerHeight + 12;

  layout.at(domainText, CONTENT_LEFT, y, CONTENT_WIDTH, domainStyle);
}

/* -------------------------------------------------------------------------- */
/* Header block                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The masthead on page 2.
 *
 * The mark, the byline and the publisher's link all live on the cover now, so
 * repeating them at the top of the summary would be saying the same thing twice
 * on facing pages. What is left is what this page actually needs: the report's
 * name at 26pt, the audited URL at full measure directly beneath it, and the
 * ember keyline that divides identity from findings.
 *
 * The URL is the one line a reader actually scans for, so it gets the widest
 * column on the page, the accent, and nothing beside it competing.
 */
function drawHeader(layout: Layout, report: AuditReport): void {
  const doc = layout.doc;
  const finalUrl = prose(report.finalUrl, URL_MAX);
  const requestedUrl = prose(report.requestedUrl, URL_MAX);
  const redirected = requestedUrl.length > 0 && requestedUrl !== finalUrl;
  const score = clampScore(report.score);

  /* --- masthead --- */

  layout.paragraph("Website Audit", CONTENT_LEFT, CONTENT_WIDTH, {
    font: "Helvetica-Bold",
    size: 26,
    color: INK,
  });
  layout.gap(11);

  /* --- the subject, at full measure --- */

  // The accent is the link affordance, so the placeholder does not borrow it.
  layout.paragraph(finalUrl || "(no URL recorded)", CONTENT_LEFT, CONTENT_WIDTH, {
    font: "Helvetica-Bold",
    size: 14,
    color: finalUrl.length > 0 ? ACCENT : MUTED,
    lineGap: 1.5,
    link: finalUrl.startsWith("http") ? finalUrl : undefined,
  });

  if (redirected) {
    layout.gap(4);
    const hops = Array.isArray(report.redirects) ? report.redirects.length : 0;
    const suffix = hops > 0 ? ` · ${hops} redirect${hops === 1 ? "" : "s"}` : "";
    layout.paragraph(`Requested ${requestedUrl}${suffix}`, CONTENT_LEFT, CONTENT_WIDTH, {
      font: "Helvetica-Oblique",
      size: 8.4,
      color: MUTED,
      lineGap: 1.4,
    });
  }

  /*
   * The one branded rule in the document, and the only one that is not grey.
   * It divides identity from findings, sits ~84pt clear of the nearest
   * severity chip, and is a hairline rather than a bar, so nothing about it
   * reads as a status indicator.
   */
  layout.gap(14);
  layout.rule(CONTENT_LEFT, CONTENT_WIDTH, ACCENT, 0.8);
  layout.gap(18);

  /* --- donut on the left, verdict and vitals on the right --- */

  const radius = 44;
  const ringColumn = 134;
  const ringTop = layout.y;
  const rightX = CONTENT_LEFT + ringColumn;
  const rightWidth = CONTENT_WIDTH - ringColumn;

  drawScoreDonut(layout, CONTENT_LEFT + ringColumn / 2 - 6, ringTop + radius + 8, radius, 11, score, report.grade);
  const ringHeight = radius * 2 + 8 + 22;

  let cursor = ringTop;

  const verdict = verdictFor(score);
  const verdictStyle: TextStyle = {
    font: "Helvetica",
    size: 10.6,
    color: INK,
    lineGap: 3.4,
  };
  const verdictHeight = layout.measure(
    layout.fitTokens(verdict, rightWidth, verdictStyle),
    rightWidth,
    verdictStyle,
  );
  layout.at(layout.fitTokens(verdict, rightWidth, verdictStyle), rightX, cursor, rightWidth, verdictStyle);
  cursor += verdictHeight + 12;

  /* Status + timestamp, with a dot that reads green only for a clean 2xx. */
  const status = Math.round(finite(report.finalStatus, 0));
  const statusOk = status >= 200 && status < 300;
  const metaStyle: TextStyle = { font: "Helvetica", size: 8.6, color: MUTED };
  const metaHeight = layout.lineHeight(metaStyle);
  doc
    .save()
    .circle(rightX + 2.4, cursor + metaHeight / 2, 2.4)
    .fill(statusOk ? SEVERITY_STYLE.pass.color : SEVERITY_STYLE.warning.color)
    .restore();
  const statusText = status > 0 ? `HTTP ${status}` : "HTTP status unknown";
  layout.at(
    `${statusText}   ·   Fetched ${formatTimestamp(report.fetchedAt)}`,
    rightX + 10,
    cursor,
    rightWidth - 10,
    metaStyle,
  );
  cursor += metaHeight + 12;

  /* Severity chips, same colour language as the web report. */
  const counts = normaliseCounts(report.counts);
  let chipX = rightX;
  for (const severity of SEVERITY_ORDER) {
    const width = chipWidth(layout, severityCountLabel(severity, counts[severity]).toUpperCase());
    if (chipX + width > rightX + rightWidth && chipX > rightX) {
      chipX = rightX;
      cursor += CHIP_HEIGHT + 5;
    }
    drawChip(layout, chipX, cursor, severity, counts[severity]);
    chipX += width + 5;
  }
  cursor += CHIP_HEIGHT;

  layout.y = Math.max(ringTop + ringHeight, cursor);
  layout.gap(18);
  layout.rule(CONTENT_LEFT, CONTENT_WIDTH);
  layout.gap(20);
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                     */
/* -------------------------------------------------------------------------- */

const TABLE_COLUMNS = { score: 52, critical: 48, warning: 52, info: 42, pass: 50 };
const TABLE_NUMERIC =
  TABLE_COLUMNS.score +
  TABLE_COLUMNS.critical +
  TABLE_COLUMNS.warning +
  TABLE_COLUMNS.info +
  TABLE_COLUMNS.pass;
const TABLE_LABEL_WIDTH = CONTENT_WIDTH - TABLE_NUMERIC;
const TABLE_ROW_HEIGHT = 17;

const TABLE_HEAD: TextStyle = {
  font: "Helvetica-Bold",
  size: 6.6,
  color: MUTED,
  characterSpacing: 1,
};

function drawTableHead(layout: Layout): void {
  const y = layout.y;
  let x = CONTENT_LEFT;
  layout.at("CATEGORY", x, y, TABLE_LABEL_WIDTH, TABLE_HEAD);
  x += TABLE_LABEL_WIDTH;
  const cells: [string, number][] = [
    ["SCORE", TABLE_COLUMNS.score],
    ["CRITICAL", TABLE_COLUMNS.critical],
    ["WARNING", TABLE_COLUMNS.warning],
    ["INFO", TABLE_COLUMNS.info],
    ["PASSED", TABLE_COLUMNS.pass],
  ];
  for (const [label, width] of cells) {
    layout.at(label, x, y, width, { ...TABLE_HEAD, align: "right" });
    x += width;
  }
  layout.y += layout.lineHeight(TABLE_HEAD) + 4;
  layout.rule(CONTENT_LEFT, CONTENT_WIDTH, "#d4d7dc", 0.8);
}

function drawCategoryTable(layout: Layout, categories: CategoryResult[], report: AuditReport): void {
  layout.keep(layout.lineHeight(TABLE_HEAD) + 5 + TABLE_ROW_HEIGHT * 2);
  drawTableHead(layout);

  const labelStyle: TextStyle = { font: "Helvetica", size: 9.3, color: INK };
  const numberStyle: TextStyle = { font: "Helvetica", size: 9.3, color: INK_SOFT, align: "right" };

  for (const category of categories) {
    if (!layout.fits(TABLE_ROW_HEIGHT)) {
      layout.newPage();
      drawTableHead(layout);
    }
    const rowTop = layout.y;
    const textY = rowTop + 4;
    const counts = normaliseCounts(category.counts);
    const score = clampScore(category.score);

    layout.at(
      layout.ellipsise(categoryLabel(category), TABLE_LABEL_WIDTH - 8, labelStyle),
      CONTENT_LEFT,
      textY,
      TABLE_LABEL_WIDTH - 8,
      labelStyle,
    );

    let x = CONTENT_LEFT + TABLE_LABEL_WIDTH;
    layout.at(String(score), x, textY, TABLE_COLUMNS.score, {
      ...numberStyle,
      font: "Helvetica-Bold",
      color: scoreInk(score),
    });
    x += TABLE_COLUMNS.score;

    const cells: [Severity, number][] = [
      ["critical", TABLE_COLUMNS.critical],
      ["warning", TABLE_COLUMNS.warning],
      ["info", TABLE_COLUMNS.info],
      ["pass", TABLE_COLUMNS.pass],
    ];
    for (const [severity, width] of cells) {
      const value = counts[severity];
      layout.at(String(value), x, textY, width, {
        ...numberStyle,
        color: value > 0 ? SEVERITY_STYLE[severity].ink : "#c7cbd1",
      });
      x += width;
    }

    layout.y = rowTop + TABLE_ROW_HEIGHT;
    layout.rule(CONTENT_LEFT, CONTENT_WIDTH, HAIRLINE_SOFT);
  }

  /* Totals. */
  if (!layout.fits(TABLE_ROW_HEIGHT)) layout.newPage();
  const rowTop = layout.y;
  const textY = rowTop + 4;
  const totals = normaliseCounts(report.counts);
  const overall = clampScore(report.score);

  layout.at("Overall", CONTENT_LEFT, textY, TABLE_LABEL_WIDTH - 8, {
    ...labelStyle,
    font: "Helvetica-Bold",
  });
  let x = CONTENT_LEFT + TABLE_LABEL_WIDTH;
  layout.at(String(overall), x, textY, TABLE_COLUMNS.score, {
    ...numberStyle,
    font: "Helvetica-Bold",
    color: scoreInk(overall),
  });
  x += TABLE_COLUMNS.score;
  const totalCells: [Severity, number][] = [
    ["critical", TABLE_COLUMNS.critical],
    ["warning", TABLE_COLUMNS.warning],
    ["info", TABLE_COLUMNS.info],
    ["pass", TABLE_COLUMNS.pass],
  ];
  for (const [severity, width] of totalCells) {
    layout.at(String(totals[severity]), x, textY, width, {
      ...numberStyle,
      font: "Helvetica-Bold",
      color: totals[severity] > 0 ? SEVERITY_STYLE[severity].ink : "#c7cbd1",
    });
    x += width;
  }
  layout.y = rowTop + TABLE_ROW_HEIGHT;
  layout.rule(CONTENT_LEFT, CONTENT_WIDTH, "#d4d7dc", 0.8);
}

function drawStatGrid(layout: Layout, report: AuditReport): void {
  const stats = report.stats;
  const timings = report.timings;
  const cells: [string, string][] = [
    ["HTML SIZE", formatBytes(finite(stats?.htmlBytes, 0))],
    ["WORDS", formatNumber(finite(stats?.wordCount, 0))],
    ["IMAGES", formatNumber(finite(stats?.imageCount, 0))],
    ["LINKS", formatNumber(finite(stats?.linkCount, 0))],
    ["SCRIPTS", formatNumber(finite(stats?.scriptCount, 0))],
    ["TEXT RATIO", `${Math.round(Math.max(0, Math.min(1, finite(stats?.textToHtmlRatio, 0))) * 100)}%`],
    ["TTFB", formatMs(finite(timings?.ttfbMs, Number.NaN))],
    ["TOTAL TIME", formatMs(finite(timings?.totalMs, Number.NaN))],
  ];

  const columns = 4;
  const gutter = 8;
  const cellWidth = (CONTENT_WIDTH - gutter * (columns - 1)) / columns;
  const cellHeight = 33;
  const rows = Math.ceil(cells.length / columns);

  layout.keep(rows * cellHeight + (rows - 1) * gutter);
  const top = layout.y;

  cells.forEach(([label, value], index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const x = CONTENT_LEFT + column * (cellWidth + gutter);
    const y = top + row * (cellHeight + gutter);

    layout.doc
      .save()
      .lineWidth(0.5)
      .roundedRect(x, y, cellWidth, cellHeight, 4)
      .fillAndStroke("#fbfbfc", HAIRLINE)
      .restore();

    layout.at(label, x + 9, y + 7, cellWidth - 18, {
      font: "Helvetica-Bold",
      size: 6.2,
      color: FAINT,
      characterSpacing: 0.9,
    });
    layout.at(layout.ellipsise(value, cellWidth - 18, { font: "Helvetica-Bold", size: 11, color: INK }), x + 9, y + 17, cellWidth - 18, {
      font: "Helvetica-Bold",
      size: 11,
      color: INK,
    });
  });

  layout.y = top + rows * cellHeight + (rows - 1) * gutter;
}

function drawRedirects(layout: Layout, redirects: RedirectHop[]): void {
  if (redirects.length === 0) return;

  layout.gap(20);
  const heading: TextStyle = { font: "Helvetica-Bold", size: 10.5, color: INK };
  layout.keep(layout.lineHeight(heading) + 24);
  layout.paragraph(
    `Redirect chain - ${redirects.length} hop${redirects.length === 1 ? "" : "s"} before the final document`,
    CONTENT_LEFT,
    CONTENT_WIDTH,
    heading,
  );
  layout.gap(7);

  const monoStyle: TextStyle = { font: "Courier", size: 7.6, color: INK_SOFT, lineGap: 1.4 };
  for (const hop of redirects.slice(0, 40)) {
    const status = Math.round(finite(hop?.status, 0));
    const from = prose(hop?.from, 160) || "?";
    const to = prose(hop?.to, 160) || "?";
    layout.paragraph(`${status || "-"}  ${from}  ->  ${to}`, CONTENT_LEFT + 4, CONTENT_WIDTH - 4, monoStyle);
    layout.gap(2.5);
  }
}

/* -------------------------------------------------------------------------- */
/* Findings                                                                    */
/* -------------------------------------------------------------------------- */

/** Fixed gutter so every chip, title and body line up down the whole document. */
function chipColumnWidth(layout: Layout): number {
  let widest = 0;
  for (const severity of SEVERITY_ORDER) {
    widest = Math.max(widest, chipWidth(layout, SEVERITY_STYLE[severity].label));
  }
  return widest + 9;
}

const FINDING_TITLE: TextStyle = { font: "Helvetica-Bold", size: 10, color: INK, lineGap: 1.4 };
const FINDING_DETAIL: TextStyle = {
  font: "Helvetica",
  size: BODY_SIZE,
  color: INK_SOFT,
  lineGap: BODY_GAP,
};
/** "HOW TO FIX". Far enough below the chip that the accent is safe here. */
const FINDING_LABEL: TextStyle = {
  font: "Helvetica-Bold",
  size: 6.3,
  color: ACCENT,
  characterSpacing: 1.4,
};

/**
 * The "01 - SEO" line above a top-priority finding.
 *
 * Same type as `FINDING_LABEL` but deliberately neutral: it sits four points
 * above a severity chip, which is exactly the adjacency where a molten orange
 * would start to look like it was grading something.
 */
const FINDING_PREFIX: TextStyle = { ...FINDING_LABEL, color: INK_SOFT };

const MONO: TextStyle = { font: "Courier", size: MONO_SIZE, color: "#1f2937", lineGap: MONO_GAP };

/**
 * A Courier panel with a tinted background and a coloured spine.
 *
 * Lines are hard-broken to the panel width up front, so nothing can run off the
 * right edge, and the panel repaints its background on each page it spans.
 */
function drawCodePanel(layout: Layout, x: number, width: number, lines: string[], spine: string): void {
  if (lines.length === 0) return;

  const pad = 5.5;
  const textX = x + pad + 3;
  const textWidth = width - pad * 2 - 3;
  const style = MONO;
  const lineHeight = layout.lineHeight(style);

  const wrapped: string[] = [];
  for (const raw of lines) {
    if (raw.length === 0) {
      wrapped.push("");
      continue;
    }
    for (const piece of layout.chop(raw, textWidth, style)) wrapped.push(piece);
  }

  let index = 0;
  while (index < wrapped.length) {
    let capacity = Math.floor((layout.remaining - pad * 2 + EPSILON) / lineHeight);
    if (capacity < 1) {
      if (layout.atPageTop) break; // Panel cannot fit anywhere; bail rather than loop.
      layout.newPage();
      capacity = Math.floor((layout.remaining - pad * 2 + EPSILON) / lineHeight);
      if (capacity < 1) break;
    }
    const take = Math.min(capacity, wrapped.length - index);
    const height = take * lineHeight + pad * 2;
    const top = layout.y;

    layout.doc.save().roundedRect(x, top, width, height, 3).fill(PANEL_BG).restore();
    layout.doc.save().rect(x, top, 2, height).fill(spine).restore();

    for (let i = 0; i < take; i += 1) {
      const text = wrapped[index + i];
      if (text === undefined || text.length === 0) continue;
      layout.at(text, textX, top + pad + i * lineHeight, textWidth, style);
    }

    layout.y = top + height;
    index += take;
    if (index < wrapped.length) layout.newPage();
  }
}

interface FindingView {
  severity: Severity;
  title: string;
  detail: string;
  fix: string;
  value: string;
  snippet: string[];
  docs: string;
}

function toView(finding: Finding): FindingView {
  const severity: Severity =
    finding?.severity === "critical" ||
    finding?.severity === "warning" ||
    finding?.severity === "info" ||
    finding?.severity === "pass"
      ? finding.severity
      : "info";

  return {
    severity,
    title: prose(finding?.title, TITLE_MAX) || "Untitled check",
    detail: prose(finding?.detail, DETAIL_MAX),
    fix: severity === "pass" ? "" : prose(finding?.fix, FIX_MAX),
    value: prose(finding?.value, VALUE_MAX),
    snippet: severity === "pass" ? [] : block(finding?.snippet, SNIPPET_MAX, SNIPPET_LINES_MAX),
    docs: prose(finding?.docs, DOCS_MAX),
  };
}

/**
 * One actionable finding.
 *
 * The head - chip, title, and the first few lines of the detail - is measured
 * and reserved as a unit so a title can never be left dangling at the foot of a
 * page. Everything after that is allowed to flow.
 */
function drawFinding(layout: Layout, view: FindingView, x: number, width: number, prefix?: string): void {
  const gutter = chipColumnWidth(layout);
  const bodyX = x + gutter;
  const bodyWidth = width - gutter;
  const style = SEVERITY_STYLE[view.severity];

  const prefixHeight = prefix ? layout.lineHeight(FINDING_PREFIX) + 4 : 0;
  const titleText = layout.fitTokens(view.title, bodyWidth, FINDING_TITLE);
  const titleHeight = layout.measure(titleText, bodyWidth, FINDING_TITLE);
  const detailLine = layout.lineHeight(FINDING_DETAIL);
  const detailHeight =
    view.detail.length > 0
      ? layout.measure(layout.fitTokens(view.detail, bodyWidth, FINDING_DETAIL), bodyWidth, FINDING_DETAIL)
      : 0;

  // Keep the head together: chip + title + up to three lines of the detail.
  const headHeight =
    prefixHeight + Math.max(titleHeight, CHIP_HEIGHT) + 4 + Math.min(detailHeight, detailLine * 3);
  layout.keep(headHeight);

  if (prefix) {
    layout.paragraph(prefix, bodyX, bodyWidth, FINDING_PREFIX);
    layout.gap(4);
  }

  drawChip(layout, x, layout.y + 1.2, view.severity);
  layout.at(titleText, bodyX, layout.y, bodyWidth, FINDING_TITLE);
  layout.y += Math.max(titleHeight, CHIP_HEIGHT);
  layout.gap(4);

  if (view.detail.length > 0) {
    layout.flow(view.detail, bodyX, bodyWidth, FINDING_DETAIL);
  }

  if (view.fix.length > 0) {
    layout.gap(7);
    layout.keep(layout.lineHeight(FINDING_LABEL) + 3 + detailLine * 2);
    layout.paragraph("HOW TO FIX", bodyX, bodyWidth, FINDING_LABEL);
    layout.gap(3);
    layout.flow(view.fix, bodyX, bodyWidth, { ...FINDING_DETAIL, color: INK });
  }

  if (view.value.length > 0) {
    layout.gap(7);
    layout.keep(layout.lineHeight(FINDING_LABEL) + 3 + layout.lineHeight(MONO) + 11);
    layout.paragraph("OBSERVED", bodyX, bodyWidth, { ...FINDING_LABEL, color: MUTED });
    layout.gap(3);
    drawCodePanel(layout, bodyX, bodyWidth, [view.value], "#cbd5e1");
  }

  if (view.snippet.length > 0) {
    layout.gap(7);
    layout.keep(layout.lineHeight(FINDING_LABEL) + 3 + layout.lineHeight(MONO) + 11);
    layout.paragraph("SNIPPET", bodyX, bodyWidth, { ...FINDING_LABEL, color: MUTED });
    layout.gap(3);
    drawCodePanel(layout, bodyX, bodyWidth, view.snippet, style.color);
  }

  if (view.docs.length > 0) {
    layout.gap(6);
    layout.line(`Reference: ${view.docs}`, bodyX, bodyWidth, {
      font: "Helvetica-Oblique",
      size: 7.6,
      color: MUTED,
      link: view.docs.startsWith("http") ? view.docs : undefined,
    });
  }
}

/** A passing check: one quiet line, because it is reassurance, not work. */
function drawPass(layout: Layout, view: FindingView, x: number, width: number): void {
  const style: TextStyle = { font: "Helvetica", size: 8.4, color: MUTED, lineGap: 1 };
  const textX = x + 10;
  const textWidth = width - 10;
  const titleHeight = layout.lineHeight(style);
  const valueHeight = view.value.length > 0 ? layout.lineHeight({ ...MONO, size: 7 }) : 0;

  layout.keep(titleHeight + valueHeight + 1);
  layout.doc
    .save()
    .circle(x + 3, layout.y + titleHeight / 2, 1.9)
    .fill(SEVERITY_STYLE.pass.color)
    .restore();
  layout.at(layout.ellipsise(view.title, textWidth, style), textX, layout.y, textWidth, style);
  layout.y += titleHeight;

  if (view.value.length > 0) {
    const valueStyle: TextStyle = { ...MONO, size: 7, color: FAINT };
    layout.at(layout.ellipsise(view.value, textWidth, valueStyle), textX, layout.y, textWidth, valueStyle);
    layout.y += valueHeight;
  }
  layout.gap(3);
}

/* -------------------------------------------------------------------------- */
/* Selection helpers                                                           */
/* -------------------------------------------------------------------------- */

function normaliseCounts(counts: SeverityCounts | null | undefined): SeverityCounts {
  return {
    critical: Math.max(0, Math.round(finite(counts?.critical, 0))),
    warning: Math.max(0, Math.round(finite(counts?.warning, 0))),
    info: Math.max(0, Math.round(finite(counts?.info, 0))),
    pass: Math.max(0, Math.round(finite(counts?.pass, 0))),
  };
}

/** Counts derived from the findings themselves, when the report omits them. */
function countFindings(findings: Finding[]): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, warning: 0, info: 0, pass: 0 };
  for (const finding of findings) {
    const severity = finding?.severity;
    if (severity === "critical" || severity === "warning" || severity === "info" || severity === "pass") {
      counts[severity] += 1;
    }
  }
  return counts;
}

/** CATEGORY_ORDER first, then anything the report carries that the order misses. */
function orderCategories(report: AuditReport): CategoryResult[] {
  const source = Array.isArray(report.categories) ? report.categories.filter(Boolean) : [];
  const byId = new Map<string, CategoryResult>();
  for (const category of source) {
    if (category && typeof category.id === "string" && !byId.has(category.id)) {
      byId.set(category.id, category);
    }
  }
  const ordered: CategoryResult[] = [];
  const seen = new Set<string>();
  for (const id of CATEGORY_ORDER) {
    const category = byId.get(id);
    if (category) {
      ordered.push(category);
      seen.add(id);
    }
  }
  for (const category of source) {
    if (typeof category.id !== "string" || seen.has(category.id)) continue;
    seen.add(category.id);
    ordered.push(category);
  }
  return ordered;
}

function categoryLabel(category: CategoryResult): string {
  const explicit = prose(category.label, 80);
  if (explicit.length > 0) return explicit;
  const meta = CATEGORY_META[category.id as CategoryId] as
    | { label: string; blurb: string; weight: number }
    | undefined;
  return prose(meta?.label, 80) || prose(category.id, 80) || "Category";
}

function categoryBlurb(category: CategoryResult): string {
  const explicit = prose(category.blurb, 200);
  if (explicit.length > 0) return explicit;
  const meta = CATEGORY_META[category.id as CategoryId] as
    | { label: string; blurb: string; weight: number }
    | undefined;
  return prose(meta?.blurb, 200);
}

function sortFindings(findings: Finding[]): Finding[] {
  const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2, pass: 3 };
  return [...findings].sort((a, b) => {
    const byRank = (rank[a?.severity] ?? 2) - (rank[b?.severity] ?? 2);
    if (byRank !== 0) return byRank;
    const byWeight = finite(b?.weight, 1) - finite(a?.weight, 1);
    if (byWeight !== 0) return byWeight;
    return String(a?.title ?? "").localeCompare(String(b?.title ?? ""));
  });
}

/** Criticals before warnings, then heaviest weight, then the weightier category. */
function pickTopFixes(
  categories: CategoryResult[],
  limit: number,
): { finding: Finding; label: string }[] {
  const pool: { finding: Finding; category: CategoryResult }[] = [];
  for (const category of categories) {
    const findings = Array.isArray(category.findings) ? category.findings : [];
    for (const finding of findings) {
      if (finding?.severity === "critical" || finding?.severity === "warning") {
        pool.push({ finding, category });
      }
    }
  }

  pool.sort((a, b) => {
    if (a.finding.severity !== b.finding.severity) {
      return a.finding.severity === "critical" ? -1 : 1;
    }
    const byWeight = finite(b.finding.weight, 1) - finite(a.finding.weight, 1);
    if (byWeight !== 0) return byWeight;
    const byCategory = finite(b.category.weight, 1) - finite(a.category.weight, 1);
    if (byCategory !== 0) return byCategory;
    return String(a.finding.title ?? "").localeCompare(String(b.finding.title ?? ""));
  });

  return pool.slice(0, limit).map(({ finding, category }) => ({
    finding,
    label: categoryLabel(category),
  }));
}

/* -------------------------------------------------------------------------- */
/* Sections                                                                    */
/* -------------------------------------------------------------------------- */

function drawTopFixes(layout: Layout, top: { finding: Finding; label: string }[]): void {
  if (top.length === 0) {
    sectionHeading(
      layout,
      "WHAT TO FIX FIRST",
      "Top priority fixes",
      "Nothing critical or warning-level came back. Everything in the breakdown below is either passing or an optional refinement.",
    );
    return;
  }

  sectionHeading(
    layout,
    "WHAT TO FIX FIRST",
    "Top priority fixes",
    `The ${top.length} highest-impact ${top.length === 1 ? "issue" : "issues"} across every category, weighted by how much each one costs you. Start here.`,
  );

  top.forEach(({ finding, label }, index) => {
    if (index > 0) {
      layout.gap(11);
      layout.rule(CONTENT_LEFT, CONTENT_WIDTH, HAIRLINE_SOFT);
      layout.gap(11);
    }
    const prefix = `${String(index + 1).padStart(2, "0")}  -  ${label.toUpperCase()}`;
    drawFinding(layout, toView(finding), CONTENT_LEFT, CONTENT_WIDTH, prefix);
  });
}

function drawCategorySection(layout: Layout, category: CategoryResult): void {
  const findings = sortFindings(Array.isArray(category.findings) ? category.findings.filter(Boolean) : []);
  const actionable = findings.filter((f) => f.severity !== "pass");
  const passes = findings.filter((f) => f.severity === "pass");

  const label = categoryLabel(category);
  const blurb = categoryBlurb(category);
  const score = clampScore(category.score);
  const counts = findings.length > 0 ? countFindings(findings) : normaliseCounts(category.counts);

  const headingStyle: TextStyle = { font: "Helvetica-Bold", size: 13.5, color: INK };
  const scoreStyle: TextStyle = {
    font: "Helvetica-Bold",
    size: 10,
    color: scoreInk(score),
    align: "right",
  };
  const blurbStyle: TextStyle = { font: "Helvetica", size: 8.6, color: MUTED, lineGap: 1.6 };
  const countStyle: TextStyle = { font: "Helvetica", size: 7.8, color: MUTED };

  const scoreText = `${score} / 100`;
  const scoreWidth = layout.widthOf(scoreText, scoreStyle) + 12;
  const headingHeight = layout.measure(label, CONTENT_WIDTH - scoreWidth, headingStyle);
  const blurbHeight = blurb.length > 0 ? layout.measure(blurb, CONTENT_WIDTH, blurbStyle) : 0;
  const countHeight = layout.lineHeight(countStyle);

  // The heading must never be the last thing on a page: reserve it plus the
  // bar, the blurb, the counts and the head of whatever finding follows.
  layout.keep(headingHeight + 8 + blurbHeight + countHeight + 46);

  const headingTop = layout.y;
  layout.at(label, CONTENT_LEFT, headingTop, CONTENT_WIDTH - scoreWidth, headingStyle);
  layout.at(
    scoreText,
    CONTENT_LEFT + CONTENT_WIDTH - scoreWidth,
    headingTop + headingHeight - layout.lineHeight(scoreStyle) - 1,
    scoreWidth,
    scoreStyle,
  );
  layout.y = headingTop + headingHeight + 5;

  drawScoreBar(layout, CONTENT_LEFT, layout.y, CONTENT_WIDTH, score);
  layout.y += 3 + 7;

  if (blurb.length > 0) {
    layout.paragraph(blurb, CONTENT_LEFT, CONTENT_WIDTH, blurbStyle);
    layout.gap(4);
  }

  /* Severity tallies, drawn piece by piece to keep the colour coding. */
  const parts = SEVERITY_ORDER.filter((severity) => counts[severity] > 0);
  if (parts.length === 0) {
    layout.at("No checks recorded", CONTENT_LEFT, layout.y, CONTENT_WIDTH, {
      ...countStyle,
      color: FAINT,
    });
  } else {
    let x = CONTENT_LEFT;
    parts.forEach((severity, index) => {
      if (index > 0) {
        const separator = "  ·  ";
        layout.at(separator, x, layout.y, CONTENT_WIDTH, { ...countStyle, color: "#c7cbd1" });
        x += layout.widthOf(separator, countStyle);
      }
      const text = severityCountLabel(severity, counts[severity]);
      layout.at(text, x, layout.y, CONTENT_WIDTH, {
        ...countStyle,
        color: severity === "pass" ? MUTED : SEVERITY_STYLE[severity].ink,
      });
      x += layout.widthOf(text, countStyle);
    });
  }
  layout.y += countHeight;
  layout.gap(6);
  layout.rule(CONTENT_LEFT, CONTENT_WIDTH, HAIRLINE);
  layout.gap(11);

  if (findings.length === 0) {
    layout.paragraph("Nothing to report for this category.", CONTENT_LEFT, CONTENT_WIDTH, {
      font: "Helvetica-Oblique",
      size: 8.8,
      color: MUTED,
    });
    return;
  }

  if (actionable.length === 0) {
    layout.paragraph("Everything here checks out.", CONTENT_LEFT, CONTENT_WIDTH, {
      font: "Helvetica-Oblique",
      size: 8.8,
      color: SEVERITY_STYLE.pass.ink,
    });
    layout.gap(8);
  }

  actionable.forEach((finding, index) => {
    if (index > 0) {
      layout.gap(9);
      layout.rule(CONTENT_LEFT, CONTENT_WIDTH, HAIRLINE_SOFT);
      layout.gap(9);
    }
    drawFinding(layout, toView(finding), CONTENT_LEFT, CONTENT_WIDTH);
  });

  if (passes.length > 0) {
    layout.gap(actionable.length > 0 ? 13 : 4);
    layout.keep(layout.lineHeight(FINDING_LABEL) + 20);
    layout.paragraph(
      severityCountLabel("pass", passes.length).toUpperCase(),
      CONTENT_LEFT,
      CONTENT_WIDTH,
      { ...FINDING_LABEL, color: SEVERITY_STYLE.pass.ink },
    );
    layout.gap(5);
    for (const finding of passes) {
      drawPass(layout, toView(finding), CONTENT_LEFT, CONTENT_WIDTH);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Back page                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What a static fetch cannot see.
 *
 * The report already files individual findings about specific unrendered
 * signals; this is the general case stated once, at the end, so nobody closes
 * the document thinking a clean score means the page was driven in a browser.
 *
 * Two sentences. It is set centred on a dark page rather than ranged left in a
 * colophon now, and a centred paragraph stops being readable somewhere around
 * the fourth line, so the long form's throat-clearing had to go.
 */
const METHOD_NOTE =
  "This audit reads the page as it was served: the HTML, the response headers and the certificate are fetched and parsed, and nothing is rendered in a browser. Signals that only exist once a browser has painted and run the page - Core Web Vitals, computed colour contrast, keyboard and focus behaviour - are outside what these checks can see, and are unmeasured rather than passing.";

/** The measure the method note sets to. Narrow enough to stay a tidy block. */
const BACK_NOTE_MEASURE = CONTENT_WIDTH * 0.82;

/**
 * One line naming what the document is about, degenerate cases included.
 *
 * `coverSubject` already guarantees a non-empty subject and already knows
 * whether it is a real one, so the two dark pages can never disagree about what
 * was audited. The timestamp is `report.fetchedAt` rather than `Date.now()`, so
 * rendering the same report twice produces the same bytes; when it will not
 * parse, the clause is dropped rather than printed as "date unavailable", which
 * on a closing page would read as a defect in the report itself.
 */
function backSubjectLine(report: AuditReport): string {
  const subject = coverSubject(report);
  const head = subject.known ? `Website audit of ${subject.text}` : "Website audit";
  const date = parseDate(report?.fetchedAt);
  return date ? `${head}   ·   ${formatTimestamp(report.fetchedAt)}` : head;
}

/**
 * The last page: dark, centred, and the cover read backwards.
 *
 * Same treatment as `drawCover` - the `DEVFORGE_COLOURS.ink` field goes down
 * over the whole MediaBox before any other ink, so the two bookends are the
 * same object rather than two similar ones - and the same measure-then-place
 * composition, so only the gaps need tuning. It is also the same `Logo` handle,
 * making this the second and last draw off bytes that were embedded once.
 *
 * The hierarchy is the cover's, inverted. The cover leads with the mark, keeps
 * the publisher quiet underneath it, opens a 54pt hole and spends its one bright
 * line on the subject: it hands the reader over to the site. This page hands the
 * reader back. The mark again, then the byline in `COVER_TEXT` - the brightest
 * line here, because the attribution is now the point - then the ember on the
 * link, then the same hole, and only then the quiet lines: what was audited and
 * when, where the report came from, and what it could not see.
 *
 * No footer. That is not an omission this page shares with the cover by
 * accident: a colophon numbered "30 of 30" reads as a page the document ran out
 * on rather than the one it was built to end at.
 */
function drawBackPage(layout: Layout, report: AuditReport, logo: Logo | null): void {
  const doc = layout.doc;

  // Full bleed, before any other ink on this page. Mirrors `drawCover`.
  doc.save().rect(0, 0, doc.page.width, doc.page.height).fill(DEVFORGE_COLOURS.ink).restore();

  const bylineStyle: TextStyle = {
    font: "Helvetica-Bold",
    size: 11,
    color: COVER_TEXT,
    align: "center",
    characterSpacing: 0.6,
  };
  const urlStyle: TextStyle = {
    font: "Helvetica",
    size: 9,
    color: COVER_EMBER,
    align: "center",
    characterSpacing: 0.7,
    link: DEVFORGE.url,
  };
  const subjectStyle: TextStyle = {
    font: "Helvetica",
    size: 8.8,
    color: COVER_QUIET,
    align: "center",
  };
  // Same colour as the line above it, 0.8pt smaller: the tool link recedes on
  // size alone rather than on a fourth grey this page does not otherwise own.
  const toolStyle: TextStyle = {
    font: "Helvetica",
    size: 8,
    color: COVER_QUIET,
    align: "center",
    link: TOOL_URL,
  };
  const noteStyle: TextStyle = {
    font: "Helvetica",
    size: 8.2,
    color: COVER_QUIET,
    align: "center",
    lineGap: 2.4,
  };

  const subjectText = layout.ellipsise(backSubjectLine(report), CONTENT_WIDTH, subjectStyle);
  const noteText = layout.fitTokens(METHOD_NOTE, BACK_NOTE_MEASURE, noteStyle);

  const markHeight = logoHeight(BACK_LOGO_WIDTH);
  const bylineHeight = layout.lineHeight(bylineStyle);
  const urlHeight = layout.lineHeight(urlStyle);
  const subjectHeight = layout.lineHeight(subjectStyle);
  const toolHeight = layout.lineHeight(toolStyle);
  const noteHeight = layout.measure(noteText, BACK_NOTE_MEASURE, noteStyle);

  const blockHeight =
    markHeight +
    30 +
    bylineHeight +
    5 +
    urlHeight +
    54 +
    subjectHeight +
    5 +
    toolHeight +
    24 +
    noteHeight;

  let y = (PAGE_HEIGHT - blockHeight) / 2 - COVER_OPTICAL_RISE;

  drawLogo(doc, logo, (PAGE_WIDTH - BACK_LOGO_WIDTH) / 2, y, BACK_LOGO_WIDTH);
  y += markHeight + 30;

  layout.at(DEVFORGE.byline, CONTENT_LEFT, y, CONTENT_WIDTH, bylineStyle);
  y += bylineHeight + 5;

  layout.at(DEVFORGE.url, CONTENT_LEFT, y, CONTENT_WIDTH, urlStyle);
  y += urlHeight + 54;

  layout.at(subjectText, CONTENT_LEFT, y, CONTENT_WIDTH, subjectStyle);
  y += subjectHeight + 5;

  layout.at("purphoros.com/tools/website-audit", CONTENT_LEFT, y, CONTENT_WIDTH, toolStyle);
  y += toolHeight + 24;

  layout.at(noteText, CONTENT_LEFT + (CONTENT_WIDTH - BACK_NOTE_MEASURE) / 2, y, BACK_NOTE_MEASURE, noteStyle);
}

/* -------------------------------------------------------------------------- */
/* Footer                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Stamps "Page N of M" on every page except the first and the last.
 *
 * The total is only knowable once the last page exists, so the document is
 * built with `bufferPages: true` and the footers are written in a second pass
 * over `bufferedPageRange()` after all the content has been laid out. Nothing
 * is flushed until `doc.end()`, so every page is still writable at that point.
 *
 * Index 0 and index `total - 1` are skipped: the two dark pages carry no page
 * furniture. `M` is still the true page count, both of them included, so a
 * thirty-page document runs "Page 2 of 30" to "Page 29 of 30" - honest about
 * how thick the thing is rather than renumbering the light body to hide two
 * pages the reader can plainly see.
 *
 * Two slots, not three. The publisher used to hold the right one, and it is on
 * its own page now; repeating it under every finding as well would be the
 * document introducing itself twenty-eight more times than it needs to. What
 * that leaves is the subject and the position, and with the third slot gone a
 * centred page number no longer reads as centred - it reads as a right-hand
 * item that stopped short, because the only other mass on the line is hard
 * against the left margin. So it moves to the right margin: two items, one at
 * each end of the hairline above them, which is the arrangement that keeps the
 * rule looking like it is holding something up.
 *
 * Takes the `Layout` rather than the document only so it can borrow
 * `ellipsise`. `lineBreak: false` is not enough to guarantee one line: it stops
 * PDFKit breaking *between* words, but a hostname is one word, and DNS allows
 * 253 characters of it. Left to itself PDFKit hard-breaks the run and the
 * overflow lands 8pt below the band, under the page it belongs to. Clipping the
 * label to its slot up front is the only thing that actually holds the footer to
 * a single line.
 */
function stampFooters(layout: Layout, host: string): void {
  const doc = layout.doc;
  const range = doc.bufferedPageRange();
  const total = range.count;
  // Nothing between the bookends means nothing to number.
  if (total <= 2) return;

  const y = PAGE_HEIGHT - MARGIN.bottom + 22;
  const style: TextStyle = { font: "Helvetica", size: 7.2, color: FAINT };

  // The stamp slot is sized once, to the widest stamp this document can
  // produce, so the numbers sit in a fixed column instead of drifting left as
  // the page count gains a digit.
  const stampSlot = layout.widthOf(`Page ${total} of ${total}`, style) + 2;
  const labelSlot = Math.max(40, CONTENT_WIDTH - stampSlot - 10);
  const label = layout.ellipsise(host.length > 0 ? host : "website audit", labelSlot, style);

  for (let index = 1; index < total - 1; index += 1) {
    doc.switchToPage(range.start + index);

    doc
      .save()
      .lineWidth(0.5)
      .strokeColor(HAIRLINE)
      .moveTo(CONTENT_LEFT, y - 9)
      .lineTo(CONTENT_LEFT + CONTENT_WIDTH, y - 9)
      .stroke()
      .restore();

    doc.font(style.font).fontSize(style.size).fillColor(style.color);
    doc.text(label, CONTENT_LEFT, y, {
      width: labelSlot,
      height: NO_IMPLICIT_BREAK,
      lineBreak: false,
    });
    doc.text(`Page ${index + 1} of ${total}`, CONTENT_LEFT + CONTENT_WIDTH - stampSlot, y, {
      width: stampSlot,
      height: NO_IMPLICIT_BREAK,
      align: "right",
      lineBreak: false,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Renders `report` to a self-contained PDF.
 *
 * Resolves once PDFKit has flushed the last chunk. The stream is buffered in
 * memory rather than piped, because the caller wants bytes for a response body,
 * not a file on a disk that will not exist in production.
 */
export async function renderAuditPdf(report: AuditReport): Promise<Buffer> {
  const host = hostOf(report?.finalUrl) || hostOf(report?.requestedUrl);
  const fetchedAt = parseDate(report?.fetchedAt);

  const doc = new PDFDocument({
    size: [PAGE_WIDTH, PAGE_HEIGHT],
    margins: MARGIN,
    bufferPages: true,
    autoFirstPage: true,
    compress: true,
    info: {
      Title: `Website Audit - ${host || "report"}`,
      Author: DEVFORGE.company,
      Subject: `Automated technical, SEO and security audit of ${prose(report?.finalUrl, 200) || "a web page"}`,
      Keywords: "website audit, SEO, accessibility, security, performance",
      Creator: PRODUCER,
      Producer: PRODUCER,
      ...(fetchedAt ? { CreationDate: fetchedAt } : {}),
    },
  });

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const layout = new Layout(doc);
  const categories = orderCategories(report);
  // Embedded once here; both dark pages draw this one handle.
  const logo = openLogo(doc);

  // Page 1 is the cover and holds nothing else, so the report starts on page 2.
  drawCover(layout, report, logo);
  layout.newPage();

  drawHeader(layout, report);

  sectionHeading(
    layout,
    "SUMMARY",
    "Scores at a glance",
    "Every category, its score out of 100, and how the checks inside it landed.",
  );
  drawCategoryTable(layout, categories, report);
  layout.gap(18);
  drawStatGrid(layout, report);
  drawRedirects(layout, Array.isArray(report.redirects) ? report.redirects.filter(Boolean) : []);

  layout.gap(26);
  drawTopFixes(layout, pickTopFixes(categories, TOP_FIXES));

  layout.gap(26);
  sectionHeading(
    layout,
    "EVERY CHECK",
    "Full breakdown",
    "Each category in full, worst first. Passing checks are listed at the end of each section for completeness.",
  );

  categories.forEach((category, index) => {
    if (index > 0) {
      layout.gap(22);
      layout.rule(CONTENT_LEFT, CONTENT_WIDTH, "#d4d7dc", 0.8);
      layout.gap(16);
    }
    drawCategorySection(layout, category);
  });

  if (categories.length === 0) {
    layout.paragraph("No categories were recorded for this audit.", CONTENT_LEFT, CONTENT_WIDTH, {
      font: "Helvetica-Oblique",
      size: 9,
      color: MUTED,
    });
  }

  // The closing attribution is a page of its own, never a block flowed under
  // the last finding, so it always breaks rather than measuring for a fit.
  layout.newPage();
  drawBackPage(layout, report, logo);

  stampFooters(layout, host);
  doc.end();

  return done;
}
