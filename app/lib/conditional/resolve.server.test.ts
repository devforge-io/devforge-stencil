import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConditionals } from "./resolve.server";
import type { ComponentData } from "../component.server";
import type { ConditionContext, ConditionalSpec } from "./types";

// A conditional that shows the profile menu when logged in, else a login button.
const SPEC: ConditionalSpec = {
  branches: [
    { id: "a", condition: { signal: "auth.loggedIn", op: "is", value: true }, show: { kind: "component", slug: "profile-menu" } },
    { id: "b", else: true, show: { kind: "component", slug: "login-button" } },
  ],
  fallback: "none",
};

function comp(slug: string, extra: Partial<ComponentData>): ComponentData {
  return { slug, name: slug, category: "x", html: "", css: "", sha: "sha", ...extra };
}

const COMPONENTS: Record<string, ComponentData> = {
  "auth-gate": comp("auth-gate", { type: "conditional", spec: SPEC, html: `<div data-pb-conditional="auth-gate"></div>` }),
  "profile-menu": comp("profile-menu", { html: `<nav class="profile">SECRET profile for ben</nav>`, css: ".profile{color:red}" }),
  "login-button": comp("login-button", { html: `<a class="login" href="/login">Log in</a>`, css: ".login{color:blue}" }),
};

const load = async (slug: string) => COMPONENTS[slug] ?? null;
const req = new Request("http://localhost/");

function ctx(loggedIn: boolean): ConditionContext {
  return {
    auth: { loggedIn, username: loggedIn ? "ben" : null },
    query: {},
    data: {},
    device: "desktop",
  };
}

const PAGE = `<h1>Welcome</h1><div data-pb-conditional="auth-gate" data-pb-name="Auth"><span>placeholder</span></div>`;

test("logged-in visitor gets the profile branch; login markup is absent", async () => {
  const res = await resolveConditionals(PAGE, req, undefined, { loadComponent: load, context: ctx(true) });
  assert.ok(res.resolved);
  assert.match(res.html, /SECRET profile for ben/);
  assert.doesNotMatch(res.html, /Log in/); // hidden branch never emitted
  assert.doesNotMatch(res.html, /data-pb-conditional/); // placeholder consumed
  assert.match(res.css, /\.profile/);
  assert.doesNotMatch(res.css, /\.login/); // only chosen branch's CSS merged
});

test("anonymous visitor gets the login branch; profile markup is absent", async () => {
  const res = await resolveConditionals(PAGE, req, undefined, { loadComponent: load, context: ctx(false) });
  assert.ok(res.resolved);
  assert.match(res.html, /Log in/);
  assert.doesNotMatch(res.html, /SECRET profile/); // logged-in markup never sent to anon
  assert.doesNotMatch(res.html, /placeholder/); // editor placeholder content gone
  assert.match(res.css, /\.login/);
});

test("no match and no else → fallback removes the placeholder (none)", async () => {
  const spec: ConditionalSpec = {
    branches: [{ id: "a", condition: { signal: "auth.loggedIn", op: "is", value: true }, show: { kind: "component", slug: "profile-menu" } }],
    fallback: "none",
  };
  const map: Record<string, ComponentData> = {
    gate: comp("gate", { type: "conditional", spec }),
    "profile-menu": COMPONENTS["profile-menu"],
  };
  const html = `<div data-pb-conditional="gate">x</div><p>after</p>`;
  const res = await resolveConditionals(html, req, undefined, { loadComponent: async (s) => map[s] ?? null, context: ctx(false) });
  assert.doesNotMatch(res.html, /data-pb-conditional/);
  assert.match(res.html, /<p>after<\/p>/);
});

test("fallback 'empty' leaves an empty box", async () => {
  const spec: ConditionalSpec = {
    branches: [{ id: "a", condition: { signal: "auth.loggedIn", op: "is", value: true }, show: { kind: "component", slug: "profile-menu" } }],
    fallback: "empty",
  };
  const map: Record<string, ComponentData> = { gate: comp("gate", { type: "conditional", spec }) };
  const html = `<div data-pb-conditional="gate" class="box">x</div>`;
  const res = await resolveConditionals(html, req, undefined, { loadComponent: async (s) => map[s] ?? null, context: ctx(false) });
  assert.match(res.html, /class="box"/); // box kept
  assert.doesNotMatch(res.html, /data-pb-conditional/); // marker stripped
  assert.doesNotMatch(res.html, />x</); // inner content cleared
});

test("pages without placeholders are returned untouched and not 'resolved'", async () => {
  const res = await resolveConditionals(`<h1>plain</h1>`, req, undefined, { loadComponent: load, context: ctx(false) });
  assert.equal(res.resolved, false);
  assert.equal(res.html, `<h1>plain</h1>`);
});

test("unknown conditional slug is removed (fails closed, no leak)", async () => {
  const html = `<div data-pb-conditional="missing">leak?</div><p>ok</p>`;
  const res = await resolveConditionals(html, req, undefined, { loadComponent: async () => null, context: ctx(true) });
  assert.doesNotMatch(res.html, /leak\?/);
  assert.match(res.html, /<p>ok<\/p>/);
});

// --- nested conditionals (Phase 2) ----------------------------------------

test("a branch target that is itself a conditional is resolved recursively", async () => {
  // outer: if loggedIn → inner (conditional); else → login
  // inner: if device=mobile → mobile-deep; else → desktop-deep
  const outerSpec: ConditionalSpec = {
    branches: [
      { id: "o1", condition: { signal: "auth.loggedIn", op: "is", value: true }, show: { kind: "component", slug: "inner" } },
      { id: "o2", else: true, show: { kind: "component", slug: "login-button" } },
    ],
    fallback: "none",
  };
  const innerSpec: ConditionalSpec = {
    branches: [
      { id: "i1", condition: { signal: "device", op: "is", value: "mobile" }, show: { kind: "component", slug: "mobile-deep" } },
      { id: "i2", else: true, show: { kind: "component", slug: "desktop-deep" } },
    ],
    fallback: "none",
  };
  const map: Record<string, ComponentData> = {
    outer: comp("outer", { type: "conditional", spec: outerSpec }),
    inner: comp("inner", { type: "conditional", spec: innerSpec }),
    "mobile-deep": comp("mobile-deep", { html: `<div class="m">MOBILE DEEP</div>`, css: ".m{}" }),
    "desktop-deep": comp("desktop-deep", { html: `<div class="d">DESKTOP DEEP</div>`, css: ".d{}" }),
    "login-button": COMPONENTS["login-button"],
  };
  const html = `<div data-pb-conditional="outer"></div>`;

  // logged in + desktop → desktop-deep, nothing else leaks
  const desktop = await resolveConditionals(html, req, undefined, {
    loadComponent: async (s) => map[s] ?? null,
    context: { auth: { loggedIn: true, username: "ben" }, query: {}, data: {}, device: "desktop" },
  });
  assert.match(desktop.html, /DESKTOP DEEP/);
  assert.doesNotMatch(desktop.html, /MOBILE DEEP/);
  assert.doesNotMatch(desktop.html, /Log in/);

  // logged in + mobile → mobile-deep
  const mobile = await resolveConditionals(html, req, undefined, {
    loadComponent: async (s) => map[s] ?? null,
    context: { auth: { loggedIn: true, username: "ben" }, query: {}, data: {}, device: "mobile" },
  });
  assert.match(mobile.html, /MOBILE DEEP/);
  assert.doesNotMatch(mobile.html, /DESKTOP DEEP/);
});

test("a cycle in nested conditionals terminates via the depth guard", async () => {
  // a → b → a forever under the same context; should not hang or throw.
  const aSpec: ConditionalSpec = { branches: [{ id: "x", else: true, show: { kind: "component", slug: "b" } }], fallback: "none" };
  const bSpec: ConditionalSpec = { branches: [{ id: "y", else: true, show: { kind: "component", slug: "a" } }], fallback: "none" };
  const map: Record<string, ComponentData> = {
    a: comp("a", { type: "conditional", spec: aSpec }),
    b: comp("b", { type: "conditional", spec: bSpec }),
  };
  const res = await resolveConditionals(`<div data-pb-conditional="a">x</div><p>ok</p>`, req, undefined, {
    loadComponent: async (s) => map[s] ?? null,
    context: ctx(false),
  });
  assert.match(res.html, /<p>ok<\/p>/); // page still renders
  assert.doesNotMatch(res.html, /data-pb-conditional/); // placeholder consumed/removed
});
