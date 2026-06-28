import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, pickBranch, resolveSignal } from "./evaluate";
import type { Condition, ConditionContext, ConditionalSpec } from "./types";

function ctx(overrides: Partial<ConditionContext> = {}): ConditionContext {
  return {
    auth: { loggedIn: false, username: null },
    query: {},
    data: {},
    device: "desktop",
    ...overrides,
  };
}

// --- resolveSignal --------------------------------------------------------

test("resolveSignal walks dotted paths", () => {
  const c = ctx({ auth: { loggedIn: true, username: "ben" } });
  assert.equal(resolveSignal("auth.loggedIn", c), true);
  assert.equal(resolveSignal("auth.username", c), "ben");
});

test("resolveSignal returns undefined for missing segments", () => {
  assert.equal(resolveSignal("query.missing", ctx()), undefined);
  assert.equal(resolveSignal("nope.nested.deep", ctx()), undefined);
});

// --- leaf operators -------------------------------------------------------

test("is — boolean coercion from string signal", () => {
  assert.equal(
    evaluate({ signal: "auth.loggedIn", op: "is", value: true }, ctx({ auth: { loggedIn: true, username: "x" } })),
    true
  );
  assert.equal(
    evaluate({ signal: "query.flag", op: "is", value: true }, ctx({ query: { flag: "true" } })),
    true
  );
  assert.equal(
    evaluate({ signal: "query.flag", op: "is", value: true }, ctx({ query: { flag: "false" } })),
    false
  );
});

test("is / is-not — string equality", () => {
  const c = ctx({ query: { tab: "settings" } });
  assert.equal(evaluate({ signal: "query.tab", op: "is", value: "settings" }, c), true);
  assert.equal(evaluate({ signal: "query.tab", op: "is-not", value: "billing" }, c), true);
  assert.equal(evaluate({ signal: "query.tab", op: "is", value: "billing" }, c), false);
});

test("is — number coercion", () => {
  const c = ctx({ query: { plan: "5" } });
  assert.equal(evaluate({ signal: "query.plan", op: "is", value: 5 }, c), true);
  assert.equal(evaluate({ signal: "query.plan", op: "is", value: 6 }, c), false);
});

test("numeric comparisons coerce string signals and fail closed on NaN", () => {
  const c = ctx({ query: { plan: "7" } });
  assert.equal(evaluate({ signal: "query.plan", op: "gt", value: 5 }, c), true);
  assert.equal(evaluate({ signal: "query.plan", op: "lt", value: 5 }, c), false);
  assert.equal(evaluate({ signal: "query.plan", op: "gte", value: 7 }, c), true);
  assert.equal(evaluate({ signal: "query.plan", op: "lte", value: 7 }, c), true);
  // non-numeric signal → fail closed
  assert.equal(
    evaluate({ signal: "query.plan", op: "gt", value: 5 }, ctx({ query: { plan: "abc" } })),
    false
  );
  // missing signal → fail closed
  assert.equal(evaluate({ signal: "query.plan", op: "gt", value: 5 }, ctx()), false);
});

test("contains — substring and array membership", () => {
  assert.equal(
    evaluate({ signal: "query.tags", op: "contains", value: "pro" }, ctx({ query: { tags: "free,pro,team" } })),
    true
  );
  assert.equal(
    evaluate({ signal: "data.roles", op: "contains", value: "admin" }, ctx({ data: { roles: ["user", "admin"] } })),
    true
  );
  assert.equal(
    evaluate({ signal: "data.roles", op: "contains", value: "owner" }, ctx({ data: { roles: ["user", "admin"] } })),
    false
  );
});

test("matches — regex, invalid pattern fails closed", () => {
  assert.equal(
    evaluate({ signal: "query.email", op: "matches", value: "@example\\.com$" }, ctx({ query: { email: "a@example.com" } })),
    true
  );
  assert.equal(
    evaluate({ signal: "query.email", op: "matches", value: "(" }, ctx({ query: { email: "a@example.com" } })),
    false
  );
});

test("exists — present vs missing", () => {
  assert.equal(evaluate({ signal: "query.ref", op: "exists" }, ctx({ query: { ref: "" } })), true);
  assert.equal(evaluate({ signal: "query.ref", op: "exists" }, ctx()), false);
});

// --- combinators ----------------------------------------------------------

test("all / any / not", () => {
  const c = ctx({ auth: { loggedIn: true, username: "ben" }, query: { plan: "7" } });
  const loggedInAndPlanGt5: Condition = {
    all: [
      { signal: "auth.loggedIn", op: "is", value: true },
      { signal: "query.plan", op: "gt", value: 5 },
    ],
  };
  assert.equal(evaluate(loggedInAndPlanGt5, c), true);
  assert.equal(evaluate(loggedInAndPlanGt5, ctx({ auth: { loggedIn: true, username: "x" }, query: { plan: "2" } })), false);

  assert.equal(
    evaluate({ any: [{ signal: "device", op: "is", value: "mobile" }, { signal: "auth.loggedIn", op: "is", value: true }] }, c),
    true
  );
  assert.equal(evaluate({ not: { signal: "auth.loggedIn", op: "is", value: true } }, c), false);
});

test("empty all is true, empty any is false", () => {
  assert.equal(evaluate({ all: [] }, ctx()), true);
  assert.equal(evaluate({ any: [] }, ctx()), false);
});

// --- pickBranch -----------------------------------------------------------

test("pickBranch — first match wins, else fallback", () => {
  const spec: ConditionalSpec = {
    branches: [
      { id: "a", condition: { signal: "auth.loggedIn", op: "is", value: true }, show: { kind: "component", slug: "profile" } },
      { id: "b", else: true, show: { kind: "component", slug: "login" } },
    ],
  };
  assert.deepEqual(pickBranch(spec, ctx({ auth: { loggedIn: true, username: "x" } })), { kind: "component", slug: "profile" });
  assert.deepEqual(pickBranch(spec, ctx()), { kind: "component", slug: "login" });
});

test("pickBranch — no match and no else returns null", () => {
  const spec: ConditionalSpec = {
    branches: [
      { id: "a", condition: { signal: "auth.loggedIn", op: "is", value: true }, show: { kind: "component", slug: "profile" } },
    ],
  };
  assert.equal(pickBranch(spec, ctx()), null);
});
