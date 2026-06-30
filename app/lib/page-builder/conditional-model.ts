/**
 * Shared editor model for conditional components.
 *
 * Both the simple branch editor (properties panel) and the Phase 2 flow canvas
 * operate on this in-memory `EditBranch[]` shape and convert to/from the stored
 * `ConditionalSpec`. Keeping it pure (no React) lets it be unit-tested and reused
 * across both editors.
 */
import type {
  Condition,
  ConditionContext,
  ConditionalSpec,
  Operator,
} from "../conditional/types";
import { isAll, isAny, isLeaf, isNot } from "../conditional/types";
import { evaluate } from "../conditional/evaluate";
import { timeSignals } from "../conditional/signals";
import { generateId } from "./utils";

export const SELECT_CLS =
  "h-7 w-full rounded-md border border-input bg-transparent px-2 text-[11px] shadow-sm focus:outline-none focus:ring-1 focus:ring-ring";

export const OPERATORS: { value: Operator; label: string }[] = [
  { value: "is", label: "is" },
  { value: "is-not", label: "is not" },
  { value: "gt", label: "greater than" },
  { value: "lt", label: "less than" },
  { value: "gte", label: "≥" },
  { value: "lte", label: "≤" },
  { value: "contains", label: "contains" },
  { value: "matches", label: "matches (regex)" },
  { value: "exists", label: "exists" },
];

export const SIGNAL_SUGGESTIONS = [
  "auth.loggedIn",
  "auth.username",
  "auth.roles",
  "auth.attributes.",
  "device",
  "query.",
  "data.",
  "time.hour",
  "time.day",
  "time.date",
  "geo.country",
  "geo.region",
  "ab.group",
  "ab.bucket",
];

export interface ComponentChoice {
  slug: string;
  name: string;
  type?: string;
}

export type Leaf = { signal: string; op: Operator; value?: unknown };
export type Group = { mode: "all" | "any"; leaves: Leaf[] };

/** A branch target while editing: an existing component, or inline markup. */
export type TargetDraft =
  | { kind: "component"; slug: string }
  | { kind: "inline"; html: string; css: string };

export type EditBranch = { id: string; isElse: boolean; group: Group; target: TargetDraft };

export function emptyTarget(): TargetDraft {
  return { kind: "component", slug: "" };
}

export function cloneGroup(g: Group): Group {
  return { mode: g.mode, leaves: g.leaves.map((l) => ({ ...l })) };
}

/**
 * Draggable starting points for the flow canvas — "conditions with properties"
 * that drop in pre-filled, plus the catch-all "Otherwise". Authors drop one and
 * tweak its leaves; the format is identical to a hand-built branch.
 */
export interface ConditionTemplate {
  id: string;
  label: string;
  isElse?: boolean;
  group: Group;
}

export const CONDITION_TEMPLATES: ConditionTemplate[] = [
  { id: "blank", label: "Blank condition", group: { mode: "all", leaves: [] } },
  { id: "logged-in", label: "Logged in", group: { mode: "all", leaves: [{ signal: "auth.loggedIn", op: "is", value: true }] } },
  { id: "logged-out", label: "Logged out", group: { mode: "all", leaves: [{ signal: "auth.loggedIn", op: "is", value: false }] } },
  { id: "mobile", label: "On mobile", group: { mode: "all", leaves: [{ signal: "device", op: "is", value: "mobile" }] } },
  { id: "role-admin", label: "Has role: admin", group: { mode: "all", leaves: [{ signal: "auth.roles", op: "contains", value: "admin" }] } },
  { id: "ab-a", label: "A/B group A", group: { mode: "all", leaves: [{ signal: "ab.group", op: "is", value: "a" }] } },
  { id: "country", label: "Country = …", group: { mode: "all", leaves: [{ signal: "geo.country", op: "is", value: "" }] } },
  { id: "query", label: "Has query param", group: { mode: "all", leaves: [{ signal: "query.", op: "exists" }] } },
];

export const OTHERWISE_TEMPLATE: ConditionTemplate = {
  id: "otherwise",
  label: "Otherwise (default)",
  isElse: true,
  group: { mode: "all", leaves: [] },
};

// --- Spec <-> editor model -------------------------------------------------

export function conditionToGroup(c?: Condition): Group {
  if (!c) return { mode: "all", leaves: [] };
  if (isAll(c)) return { mode: "all", leaves: c.all.filter(isLeaf) };
  if (isAny(c)) return { mode: "any", leaves: c.any.filter(isLeaf) };
  if (isLeaf(c)) return { mode: "all", leaves: [c] };
  return { mode: "all", leaves: [] }; // `not` groups round-trip via the raw spec
}

export function groupToCondition(g: Group): Condition | undefined {
  const leaves = g.leaves.filter((l) => l.signal.trim() !== "");
  if (leaves.length === 0) return undefined; // incomplete branch never matches
  if (leaves.length === 1) return leaves[0];
  return g.mode === "any" ? { any: leaves } : { all: leaves };
}

function showToTarget(show?: { kind: "component"; slug: string } | { kind: "inline"; html: string; css?: string }): TargetDraft {
  if (show?.kind === "inline") return { kind: "inline", html: show.html ?? "", css: show.css ?? "" };
  return { kind: "component", slug: show?.kind === "component" ? show.slug : "" };
}

function targetToShow(t: TargetDraft) {
  if (t.kind === "inline") return t.css ? { kind: "inline" as const, html: t.html, css: t.css } : { kind: "inline" as const, html: t.html };
  return { kind: "component" as const, slug: t.slug };
}

export function specToBranches(spec: ConditionalSpec): EditBranch[] {
  return spec.branches.map((b) => ({
    id: b.id || generateId(),
    isElse: !!b.else,
    group: conditionToGroup(b.condition),
    target: showToTarget(b.show),
  }));
}

export function branchesToSpec(
  branches: EditBranch[],
  fallback: "none" | "empty",
  layout?: Record<string, { x: number; y: number }>
): ConditionalSpec {
  // The `else` branch is always evaluated last regardless of editor ordering.
  const ordered = [...branches.filter((b) => !b.isElse), ...branches.filter((b) => b.isElse)];
  const spec: ConditionalSpec = {
    branches: ordered.map((b) =>
      b.isElse
        ? { id: b.id, else: true, show: targetToShow(b.target) }
        : { id: b.id, condition: groupToCondition(b.group), show: targetToShow(b.target) }
    ),
    fallback,
  };
  if (layout && Object.keys(layout).length > 0) spec.layout = layout;
  return spec;
}

// --- Value coercion (string input -> typed value) --------------------------

export function parseValue(raw: string): boolean | number | string {
  const t = raw.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t !== "" && Number.isFinite(Number(t))) return Number(t);
  return raw;
}

export function displayValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v);
}

// --- Human-readable summaries (for flow nodes / labels) --------------------

export function summarizeLeaf(l: Leaf): string {
  if (!l.signal.trim()) return "…";
  if (l.op === "exists") return `${l.signal} exists`;
  const label = OPERATORS.find((o) => o.value === l.op)?.label ?? l.op;
  return `${l.signal} ${label} ${displayValue(l.value)}`.trim();
}

export function summarizeGroup(g: Group): string {
  const parts = g.leaves.filter((l) => l.signal.trim() !== "").map(summarizeLeaf);
  if (parts.length === 0) return "(no conditions)";
  return parts.join(g.mode === "any" ? " OR " : " AND ");
}

export function summarizeTarget(t: TargetDraft): string {
  if (t.kind === "inline") return t.html.trim() ? "inline HTML" : "inline (empty)";
  return t.slug || "(no component)";
}

export function summarizeCondition(c?: Condition): string {
  if (!c) return "(always)";
  if (isAll(c)) return c.all.map(summarizeCondition).join(" AND ") || "(always)";
  if (isAny(c)) return c.any.map(summarizeCondition).join(" OR ");
  if (isNot(c)) return `NOT (${summarizeCondition(c.not)})`;
  if (isLeaf(c)) return summarizeLeaf(c as Leaf);
  return "";
}

// --- Live preview ----------------------------------------------------------

/** The id of the first branch that matches `context` (or the else branch). */
export function activeBranchId(
  branches: EditBranch[],
  context: ConditionContext
): string | null {
  for (const b of branches) {
    if (b.isElse) return b.id;
    const cond = groupToCondition(b.group);
    if (cond && evaluate(cond, context)) return b.id;
  }
  return null;
}

export interface SampleInputs {
  loggedIn: boolean;
  username: string;
  roles: string; // comma-separated, e.g. "member,admin"
  query: string; // querystring, e.g. "plan=7&tab=billing"
  data: string; // JSON object
  device: "mobile" | "desktop";
  country: string; // geo.country, e.g. "GB"
  abGroup: "a" | "b";
}

export const DEFAULT_SAMPLE: SampleInputs = {
  loggedIn: false,
  username: "",
  roles: "",
  query: "",
  data: "",
  device: "desktop",
  country: "",
  abGroup: "a",
};

/** Build a ConditionContext from the preview panel's sample inputs. */
export function sampleToContext(s: SampleInputs): ConditionContext {
  const query: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(s.query)) query[k] = v;
  let data: Record<string, unknown> = {};
  let attributes: Record<string, unknown> = {};
  try {
    const parsed = s.data.trim() ? JSON.parse(s.data) : {};
    if (parsed && typeof parsed === "object") {
      data = parsed as Record<string, unknown>;
      attributes = parsed as Record<string, unknown>; // reuse as auth.attributes for preview
    }
  } catch {
    // invalid JSON -> empty bags
  }
  const roles = s.roles.split(",").map((r) => r.trim()).filter(Boolean);
  return {
    auth: {
      loggedIn: s.loggedIn,
      username: s.loggedIn ? s.username || "preview-user" : null,
      id: s.loggedIn ? "preview" : null,
      roles: s.loggedIn ? roles : [],
      attributes,
    },
    query,
    data,
    device: s.device,
    time: timeSignals(new Date()),
    geo: { country: s.country.trim() || null, region: null, city: null },
    ab: { bucket: s.abGroup === "b" ? 75 : 25, group: s.abGroup },
  };
}
