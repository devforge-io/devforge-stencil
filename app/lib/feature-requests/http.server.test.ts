import { test } from "node:test";
import assert from "node:assert/strict";
import { originAllowed, normalizeOrigin } from "./http.server";

test("exact origin match including port", () => {
  const list = ["https://devforge.io", "http://localhost:5175"];
  assert.equal(originAllowed("https://devforge.io", list), true);
  assert.equal(originAllowed("https://DEVFORGE.io", list), true);
  assert.equal(originAllowed("http://devforge.io", list), false);
  assert.equal(originAllowed("https://www.devforge.io", list), false);
  assert.equal(originAllowed("http://localhost:5175", list), true);
  assert.equal(originAllowed("http://localhost:5176", list), false);
});

test("portless localhost entry matches any local port", () => {
  const list = ["http://localhost"];
  assert.equal(originAllowed("http://localhost:5176", list), true);
  assert.equal(originAllowed("http://localhost:3000", list), true);
  assert.equal(originAllowed("http://localhost", list), true);
  assert.equal(originAllowed("https://localhost:5176", list), false);
  assert.equal(originAllowed("http://127.0.0.1:8080", list), false);
  assert.equal(originAllowed("http://127.0.0.1:8080", ["http://127.0.0.1"]), true);
  assert.equal(originAllowed("http://evil.example:80", ["http://evil.example"]), true);
  assert.equal(originAllowed("http://evil.example:8080", ["http://evil.example"]), false);
});

test("normalizeOrigin lowercases and strips paths", () => {
  assert.equal(normalizeOrigin("HTTPS://Example.com/path"), "https://example.com");
  assert.equal(normalizeOrigin("example.com"), "https://example.com");
});
