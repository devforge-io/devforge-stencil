import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeBranchId,
  branchesToSpec,
  sampleToContext,
  specToBranches,
  summarizeCondition,
  type EditBranch,
} from "./conditional-model";
import type { ConditionalSpec } from "../conditional/types";

function leafBranch(id: string, signal: string, value: unknown, slug: string): EditBranch {
  return { id, isElse: false, group: { mode: "all", leaves: [{ signal, op: "is", value }] }, target: { kind: "component", slug } };
}

// --- spec <-> editor round trip -------------------------------------------

test("specToBranches/branchesToSpec round-trips a canonical spec", () => {
  const spec: ConditionalSpec = {
    branches: [
      {
        id: "a",
        condition: { all: [{ signal: "auth.loggedIn", op: "is", value: true }, { signal: "query.plan", op: "gt", value: 5 }] },
        show: { kind: "component", slug: "pro" },
      },
      { id: "b", condition: { signal: "device", op: "is", value: "mobile" }, show: { kind: "component", slug: "mobile-cta" } },
      { id: "c", else: true, show: { kind: "component", slug: "default" } },
    ],
    fallback: "none",
  };
  const out = branchesToSpec(specToBranches(spec), "none");
  assert.deepEqual(out, spec);
});

test("branchesToSpec forces the else branch last regardless of order", () => {
  const branches: EditBranch[] = [
    { id: "else", isElse: true, group: { mode: "all", leaves: [] }, target: { kind: "component", slug: "x" } },
    leafBranch("a", "auth.loggedIn", true, "y"),
  ];
  const spec = branchesToSpec(branches, "none");
  assert.equal(spec.branches[0].id, "a");
  assert.equal(spec.branches[1].id, "else");
  assert.equal(spec.branches[1].else, true);
});

test("an incomplete condition (no signal) becomes an undefined condition that never matches", () => {
  const branches: EditBranch[] = [
    { id: "a", isElse: false, group: { mode: "all", leaves: [{ signal: "  ", op: "is", value: "x" }] }, target: { kind: "component", slug: "t" } },
  ];
  const spec = branchesToSpec(branches, "none");
  assert.equal(spec.branches[0].condition, undefined);
});

test("inline branch targets round-trip through the editor model", () => {
  const spec: ConditionalSpec = {
    branches: [
      { id: "a", condition: { signal: "geo.country", op: "is", value: "GB" }, show: { kind: "inline", html: "<p>Hi UK</p>", css: ".x{}" } },
      { id: "b", else: true, show: { kind: "inline", html: "<p>Hi</p>" } },
    ],
    fallback: "none",
  };
  const out = branchesToSpec(specToBranches(spec), "none");
  assert.deepEqual(out, spec);
});

// --- summaries -------------------------------------------------------------

test("summarizeCondition renders readable strings", () => {
  assert.equal(summarizeCondition({ signal: "auth.loggedIn", op: "is", value: true }), "auth.loggedIn is true");
  assert.equal(summarizeCondition({ signal: "query.ref", op: "exists" }), "query.ref exists");
  assert.equal(
    summarizeCondition({ all: [{ signal: "a", op: "is", value: 1 }, { signal: "b", op: "gt", value: 2 }] }),
    "a is 1 AND b greater than 2"
  );
  assert.equal(summarizeCondition({ any: [{ signal: "a", op: "is", value: 1 }, { signal: "b", op: "is", value: 2 }] }), "a is 1 OR b is 2");
  assert.equal(summarizeCondition({ not: { signal: "a", op: "is", value: 1 } }), "NOT (a is 1)");
});

// --- live preview ----------------------------------------------------------

test("activeBranchId picks the first matching branch, else, or null", () => {
  const branches: EditBranch[] = [
    leafBranch("a", "auth.loggedIn", true, "profile"),
    { id: "z", isElse: true, group: { mode: "all", leaves: [] }, target: { kind: "component", slug: "login" } },
  ];
  const base = { roles: "", query: "", data: "", device: "desktop" as const, country: "", abGroup: "a" as const };
  assert.equal(activeBranchId(branches, sampleToContext({ ...base, loggedIn: true, username: "ben" })), "a");
  assert.equal(activeBranchId(branches, sampleToContext({ ...base, loggedIn: false, username: "" })), "z");

  // no else, no match → null
  assert.equal(
    activeBranchId([leafBranch("a", "auth.loggedIn", true, "x")], sampleToContext({ ...base, loggedIn: false, username: "" })),
    null
  );
});

test("sampleToContext parses query, data JSON, roles, geo and ab", () => {
  const ctx = sampleToContext({
    loggedIn: true, username: "ben", roles: "member, admin",
    query: "plan=7&tab=billing", data: '{"plan":7}', device: "mobile", country: "GB", abGroup: "b",
  });
  assert.equal(ctx.auth.loggedIn, true);
  assert.equal(ctx.auth.username, "ben");
  assert.deepEqual(ctx.auth.roles, ["member", "admin"]);
  assert.equal(ctx.auth.attributes?.plan, 7);
  assert.equal(ctx.query.plan, "7");
  assert.equal(ctx.query.tab, "billing");
  assert.equal(ctx.data.plan, 7);
  assert.equal(ctx.device, "mobile");
  assert.equal(ctx.geo?.country, "GB");
  assert.equal(ctx.ab?.group, "b");

  // invalid JSON → empty data, not a throw
  const bad = sampleToContext({ loggedIn: false, username: "", roles: "", query: "", data: "{not json", device: "desktop", country: "", abGroup: "a" });
  assert.deepEqual(bad.data, {});
  assert.equal(bad.auth.username, null);
});

test("branchesToSpec includes layout when provided and omits it when empty", () => {
  const branches: EditBranch[] = [leafBranch("a", "auth.loggedIn", true, "pro")];
  const layout = { a: { x: 90, y: 110 }, "tgt:a": { x: 470, y: 110 }, start: { x: 90, y: 0 } };

  const withLayout = branchesToSpec(branches, "none", layout);
  assert.deepEqual(withLayout.layout, layout);

  const noLayout = branchesToSpec(branches, "none");
  assert.equal(noLayout.layout, undefined);

  const emptyLayout = branchesToSpec(branches, "none", {});
  assert.equal(emptyLayout.layout, undefined);
});
