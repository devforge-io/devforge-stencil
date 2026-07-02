import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTextVariables } from "./resolve.server";
import type { ConditionContext } from "../conditional/types";

const REQ = new Request("http://localhost/");

function ctx(overrides: Partial<ConditionContext> = {}): ConditionContext {
  return {
    auth: { loggedIn: true, username: "ben", id: "u1", roles: ["member", "beta"], attributes: { plan: "pro" } },
    query: { ref: "twitter" },
    data: { title: "Fall Sale" },
    device: "desktop",
    geo: { country: "AU", region: null, city: null },
    time: { hour: 9, minute: 30, day: 2, date: "2026-07-02", iso: "2026-07-02T09:30:00Z", ts: 0 },
    ab: { bucket: 12, group: "a" },
    ...overrides,
  };
}

test("no braces → no-op, not resolved", async () => {
  const r = await resolveTextVariables("<p>Hello there</p>", REQ, undefined, { context: ctx() });
  assert.equal(r.resolved, false);
  assert.equal(r.private, false);
  assert.equal(r.html, "<p>Hello there</p>");
});

test("{username} shorthand resolves and marks private", async () => {
  const r = await resolveTextVariables("<p>Welcome {username}!</p>", REQ, undefined, { context: ctx() });
  assert.equal(r.html, "<p>Welcome ben!</p>");
  assert.equal(r.resolved, true);
  assert.equal(r.private, true);
});

test("logged-out {username} (null) becomes empty string, still private", async () => {
  const context = ctx({ auth: { loggedIn: false, username: null } });
  const r = await resolveTextVariables("<p>Hi {username}</p>", REQ, undefined, { context });
  assert.equal(r.html, "<p>Hi </p>");
  assert.equal(r.resolved, true);
  assert.equal(r.private, true);
});

test("unknown token is left literal", async () => {
  const r = await resolveTextVariables("<p>{usrname} and {nope}</p>", REQ, undefined, { context: ctx() });
  assert.equal(r.html, "<p>{usrname} and {nope}</p>");
  assert.equal(r.resolved, false);
  assert.equal(r.private, false);
});

test("{data.*} resolves but stays publicly cacheable", async () => {
  const r = await resolveTextVariables("<h1>{data.title}</h1>", REQ, undefined, { context: ctx() });
  assert.equal(r.html, "<h1>Fall Sale</h1>");
  assert.equal(r.resolved, true);
  assert.equal(r.private, false);
});

test("namespaced signals resolve: query, geo, roles array, attributes", async () => {
  const r = await resolveTextVariables(
    "<p>{query.ref} {geo.country} {roles} {attributes.plan}</p>",
    REQ,
    undefined,
    { context: ctx() }
  );
  assert.equal(r.html, "<p>twitter AU member, beta pro</p>");
  assert.equal(r.private, true);
});

test("values are inserted as text (no HTML injection)", async () => {
  const context = ctx({ auth: { loggedIn: true, username: "<b>x</b>" } });
  const r = await resolveTextVariables("<p>{username}</p>", REQ, undefined, { context });
  assert.equal(r.html, "<p>&lt;b&gt;x&lt;/b&gt;</p>");
});

test("attributes are not touched — only text nodes", async () => {
  const r = await resolveTextVariables('<a href="/u/{username}">{username}</a>', REQ, undefined, { context: ctx() });
  assert.equal(r.html, '<a href="/u/{username}">ben</a>');
});
