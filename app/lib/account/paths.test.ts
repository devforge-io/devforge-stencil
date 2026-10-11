import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCOUNT_PATH, SIGN_IN_PATH, safeNext, signInHref, signUpHref } from "./paths";

test("safeNext keeps same-site paths anywhere on the site", () => {
  assert.equal(safeNext("/project"), "/project");
  assert.equal(safeNext("/tools/feature-requests/projects/abc?tab=new"), "/tools/feature-requests/projects/abc?tab=new");
  assert.equal(safeNext("/"), "/");
  assert.equal(safeNext("/content/login"), "/content/login");
});

test("safeNext falls back for missing, off-site or malformed values", () => {
  assert.equal(safeNext(null), ACCOUNT_PATH);
  assert.equal(safeNext(""), ACCOUNT_PATH);
  assert.equal(safeNext("project"), ACCOUNT_PATH);
  assert.equal(safeNext("//evil.example.com"), ACCOUNT_PATH);
  assert.equal(safeNext("https://evil.example.com/"), ACCOUNT_PATH);
  assert.equal(safeNext("/pro ject"), ACCOUNT_PATH);
  assert.equal(safeNext(null, "/project"), "/project");
});

test("safeNext never returns to an auth page (would loop)", () => {
  assert.equal(safeNext("/account/sign-in"), ACCOUNT_PATH);
  assert.equal(safeNext("/account/sign-in?next=/x"), ACCOUNT_PATH);
  assert.equal(safeNext("/account/sign-up/"), ACCOUNT_PATH);
  assert.equal(safeNext("/account/sign-out"), ACCOUNT_PATH);
  assert.equal(safeNext("/login"), ACCOUNT_PATH);
  assert.equal(safeNext("/logout", "/project"), "/project");
  assert.equal(safeNext("/account"), "/account"); // the hub itself is fine
});

test("signInHref and signUpHref encode their parameters", () => {
  assert.equal(signInHref(), SIGN_IN_PATH);
  assert.equal(signInHref("/project"), "/account/sign-in?next=%2Fproject");
  assert.equal(signInHref("/p?x=1", "a+b@example.com"), "/account/sign-in?next=%2Fp%3Fx%3D1&email=a%2Bb%40example.com");
  assert.equal(signInHref(null, "a@b.co"), "/account/sign-in?email=a%40b.co");
  assert.equal(signUpHref("/project"), "/account/sign-up?next=%2Fproject");
});
