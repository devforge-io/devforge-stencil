import type {
  BranchTarget,
  Condition,
  ConditionContext,
  ConditionalSpec,
  Operator,
} from "./types";
import { isAll, isAny, isNot } from "./types";

/**
 * Resolve a dotted signal path (e.g. `auth.loggedIn`, `query.plan`) against the
 * context by walking nested objects. Returns `undefined` when any segment is
 * missing. Pure and total — never throws.
 */
export function resolveSignal(path: string, context: unknown): unknown {
  let current: unknown = context;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Evaluate a structured condition against a context. Pure and total: it never
 * throws and never runs author-supplied code. Unknown/invalid shapes fail
 * closed (return `false`).
 */
export function evaluate(condition: Condition, context: ConditionContext): boolean {
  if (isAll(condition)) return condition.all.every((c) => evaluate(c, context));
  if (isAny(condition)) return condition.any.some((c) => evaluate(c, context));
  if (isNot(condition)) return !evaluate(condition.not, context);
  if (typeof condition === "object" && condition !== null && "signal" in condition) {
    const actual = resolveSignal(condition.signal, context);
    return evaluateLeaf(actual, condition.op, condition.value);
  }
  return false;
}

/**
 * Choose the branch target for a spec under a context. Branches are evaluated
 * top-to-bottom; the first whose condition passes (or the `else` branch) wins.
 * Returns `null` when nothing matches — the caller applies the spec's fallback.
 */
export function pickBranch(
  spec: ConditionalSpec,
  context: ConditionContext
): BranchTarget | null {
  for (const branch of spec.branches) {
    if (branch.else) return branch.show;
    if (branch.condition && evaluate(branch.condition, context)) return branch.show;
  }
  return null;
}

// --- Leaf operators -------------------------------------------------------

function evaluateLeaf(actual: unknown, op: Operator, expected: unknown): boolean {
  switch (op) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "is":
      return looseEquals(actual, expected);
    case "is-not":
      return !looseEquals(actual, expected);
    case "gt":
    case "lt":
    case "gte":
    case "lte":
      return numericCompare(actual, expected, op);
    case "contains":
      return contains(actual, expected);
    case "matches":
      return matches(actual, expected);
    default:
      return false;
  }
}

/**
 * Equality with light, predictable coercion. The expected value's type drives
 * coercion so authors can write `auth.loggedIn is true` (boolean) and
 * `query.plan is 5` (number) even though signals arrive as strings.
 */
function looseEquals(actual: unknown, expected: unknown): boolean {
  if (typeof expected === "boolean") return toBool(actual) === expected;
  if (typeof expected === "number") {
    const n = toNumber(actual);
    return n !== null && n === expected;
  }
  if (actual === null || actual === undefined) return actual === expected;
  return String(actual) === String(expected);
}

/** Numeric comparison; fails closed (false) when either side isn't a number. */
function numericCompare(actual: unknown, expected: unknown, op: Operator): boolean {
  const a = toNumber(actual);
  const b = toNumber(expected);
  if (a === null || b === null) return false;
  switch (op) {
    case "gt":
      return a > b;
    case "lt":
      return a < b;
    case "gte":
      return a >= b;
    case "lte":
      return a <= b;
    default:
      return false;
  }
}

function contains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) return actual.some((x) => String(x) === String(expected));
  if (actual === null || actual === undefined) return false;
  return String(actual).includes(String(expected));
}

function matches(actual: unknown, expected: unknown): boolean {
  if (actual === null || actual === undefined) return false;
  try {
    return new RegExp(String(expected)).test(String(actual));
  } catch {
    return false; // invalid pattern fails closed
  }
}

function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true" || v === "1";
  if (typeof v === "number") return v !== 0;
  return !!v;
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
