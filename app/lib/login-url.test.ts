import { test } from "node:test";
import assert from "node:assert/strict";
import { CMS_LOGIN_PATH, normalizeLoginUrl, withNext } from "./login-url";

test("normalizeLoginUrl accepts site paths and http(s) URLs", () => {
  assert.equal(normalizeLoginUrl("/account/sign-in"), "/account/sign-in");
  assert.equal(normalizeLoginUrl("  /tools/feature-requests/sign-in?x=1 "), "/tools/feature-requests/sign-in?x=1");
  assert.equal(normalizeLoginUrl("https://auth.example.com/login"), "https://auth.example.com/login");
  assert.equal(normalizeLoginUrl("http://localhost:5174/sign-in"), "http://localhost:5174/sign-in");
  assert.equal(normalizeLoginUrl(CMS_LOGIN_PATH), CMS_LOGIN_PATH); // pointless but harmless
});

test("normalizeLoginUrl treats blank and non-string values as unset", () => {
  assert.equal(normalizeLoginUrl(""), null);
  assert.equal(normalizeLoginUrl("   "), null);
  assert.equal(normalizeLoginUrl(undefined), null);
  assert.equal(normalizeLoginUrl(null), null);
  assert.equal(normalizeLoginUrl(42), null);
});

test("normalizeLoginUrl rejects values that would loop or escape the site", () => {
  assert.equal(normalizeLoginUrl("/login"), null);
  assert.equal(normalizeLoginUrl("/login/"), null);
  assert.equal(normalizeLoginUrl("/login?next=/x"), null);
  assert.equal(normalizeLoginUrl("//evil.example.com/login"), null);
  assert.equal(normalizeLoginUrl("javascript:alert(1)"), null);
  assert.equal(normalizeLoginUrl("mailto:someone@example.com"), null);
  assert.equal(normalizeLoginUrl("account/sign-in"), null); // relative without leading slash
  assert.equal(normalizeLoginUrl("/sign in"), null); // whitespace inside
  assert.equal(normalizeLoginUrl("/sign-in\nX"), null);
});

test("normalizeLoginUrl allows deeper paths under /login", () => {
  assert.equal(normalizeLoginUrl("/login/visitors"), "/login/visitors");
});

test("withNext forwards same-site return paths only", () => {
  assert.equal(withNext("/sign-in", "/project/1"), "/sign-in?next=%2Fproject%2F1");
  assert.equal(withNext("/sign-in?src=cms", "/p"), "/sign-in?src=cms&next=%2Fp");
  assert.equal(withNext("/sign-in#form", "/p"), "/sign-in?next=%2Fp#form");
  assert.equal(withNext("https://auth.example.com/", "/p"), "https://auth.example.com/?next=%2Fp");
  assert.equal(withNext("/sign-in", null), "/sign-in");
  assert.equal(withNext("/sign-in", ""), "/sign-in");
  assert.equal(withNext("/sign-in", "//evil.example.com"), "/sign-in");
  assert.equal(withNext("/sign-in", "https://evil.example.com"), "/sign-in");
});
