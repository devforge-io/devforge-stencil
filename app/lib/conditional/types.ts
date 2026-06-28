/**
 * Conditional component data model.
 *
 * A conditional component stores a *rule set* instead of fixed markup: a list of
 * branches evaluated top-to-bottom, each guarded by a structured condition. The
 * first branch whose condition passes (or the explicit `else` branch) decides
 * which target component is rendered. See CONDITIONAL.md.
 *
 * Every shape here is intentionally serializable and free of executable code, so
 * rule sets are safe to store in Git and evaluate on the server without `eval`.
 */

export type Operator =
  | "is"
  | "is-not"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "contains"
  | "matches"
  | "exists";

/** A structured boolean expression over named signals. */
export type Condition =
  | { all: Condition[] } // AND
  | { any: Condition[] } // OR
  | { not: Condition } // negate
  | { signal: string; op: Operator; value?: unknown }; // leaf

/** What a branch renders when chosen. */
export type BranchTarget =
  | { kind: "component"; slug: string } // compose an existing component
  | { kind: "inline"; html: string; css?: string }; // inline subtree (future)

export interface Branch {
  id: string;
  condition?: Condition; // omitted on the `else` branch
  else?: boolean;
  show: BranchTarget;
}

export interface ConditionalSpec {
  /** Evaluated top-to-bottom; first match wins. */
  branches: Branch[];
  /** What to render when nothing matches and there is no `else`. */
  fallback?: "none" | "empty";
}

/**
 * The per-request context a condition is evaluated against. Signals are
 * referenced by dotted path (e.g. `auth.loggedIn`, `query.plan`) and resolved by
 * walking this nested object. Adding a signal means adding a resolver here — the
 * rule format never changes.
 */
export interface ConditionContext {
  auth: {
    loggedIn: boolean;
    username: string | null;
    /** Visitor account id (or "admin" for a CMS-admin session). */
    id?: string | null;
    /** Visitor roles, e.g. ["member"]. `auth.roles contains admin`. */
    roles?: string[];
    /** Arbitrary visitor attributes, e.g. `auth.attributes.plan gt 5`. */
    attributes?: Record<string, unknown>;
  };
  query: Record<string, string>;
  data: Record<string, unknown>;
  device: "mobile" | "desktop";
  /** Time-window signals (UTC): `time.hour`, `time.day`, `time.date`, … */
  time?: { hour: number; minute: number; day: number; date: string; iso: string; ts: number };
  /** Edge/CDN geo: `geo.country`, `geo.region`, `geo.city`. */
  geo?: { country: string | null; region: string | null; city: string | null };
  /** Stable A/B assignment: `ab.bucket` (0–99), `ab.group` ("a"|"b"). */
  ab?: { bucket: number; group: "a" | "b" };
  [namespace: string]: unknown;
}

// --- Type guards for the Condition union (keep the evaluator readable) ---

export function isAll(c: Condition): c is { all: Condition[] } {
  return typeof c === "object" && c !== null && "all" in c;
}
export function isAny(c: Condition): c is { any: Condition[] } {
  return typeof c === "object" && c !== null && "any" in c;
}
export function isNot(c: Condition): c is { not: Condition } {
  return typeof c === "object" && c !== null && "not" in c;
}
export function isLeaf(
  c: Condition
): c is { signal: string; op: Operator; value?: unknown } {
  return typeof c === "object" && c !== null && "signal" in c;
}

/** An empty spec — a freshly created conditional with no branches yet. */
export function emptySpec(): ConditionalSpec {
  return { branches: [], fallback: "none" };
}
