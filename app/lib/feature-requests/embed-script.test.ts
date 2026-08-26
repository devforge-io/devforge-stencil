import { test } from "node:test";
import assert from "node:assert/strict";
import { EMBED_SCRIPT, EMBED_SCRIPT_VERSION } from "./embed-script";

test("embed script is valid JavaScript", () => {
  assert.doesNotThrow(() => new Function(EMBED_SCRIPT));
  assert.ok(EMBED_SCRIPT.trim().startsWith("(function ()"), "wrapped in an IIFE");
  assert.equal(EMBED_SCRIPT_VERSION, "2");
});

test("embed script contains no em dashes", () => {
  assert.equal(EMBED_SCRIPT.indexOf("\u2014"), -1);
});

test("embed script talks to the three API endpoints", () => {
  assert.match(EMBED_SCRIPT, /\/api\/projects\/" \+ encodeURIComponent\(projectId\) \+ "\/board\?voter=/);
  assert.match(EMBED_SCRIPT, /\/api\/projects\/" \+ encodeURIComponent\(projectId\) \+ "\/requests"/);
  assert.match(EMBED_SCRIPT, /\/api\/requests\/" \+ encodeURIComponent\(r\.id\) \+ "\/vote"/);
});

test("embed script keeps the contract details", () => {
  assert.ok(EMBED_SCRIPT.includes('"devforge-fr-voter"'), "voter key storage name");
  assert.ok(EMBED_SCRIPT.includes("https://devforge.io/tools/feature-requests"), "powered-by link");
  assert.ok(EMBED_SCRIPT.includes("Too many requests, try again in a minute"), "429 copy");
  assert.ok(EMBED_SCRIPT.includes('attachShadow({ mode: "open" })'), "shadow root");
  assert.ok(!/\b(alert|confirm|prompt)\(/.test(EMBED_SCRIPT), "no blocking dialogs");
  assert.ok(!EMBED_SCRIPT.includes("${"), "no template placeholders leaked");
});

test("embed script stays small", () => {
  assert.ok(EMBED_SCRIPT.length < 24000, "script is " + EMBED_SCRIPT.length + " chars");
});
