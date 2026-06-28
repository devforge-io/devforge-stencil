import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, normalizeUsername } from "./visitor.server";

test("hashPassword is deterministic per salt and salt-sensitive", () => {
  const h1 = hashPassword("hunter2", "saltA");
  assert.equal(h1, hashPassword("hunter2", "saltA")); // stable
  assert.notEqual(h1, hashPassword("hunter2", "saltB")); // salt matters
  assert.notEqual(h1, hashPassword("other", "saltA")); // password matters
});

test("verifyPassword accepts the right password and rejects wrong ones", () => {
  const salt = "deadbeef";
  const hash = hashPassword("correct horse", salt);
  assert.equal(verifyPassword("correct horse", salt, hash), true);
  assert.equal(verifyPassword("wrong", salt, hash), false);
  assert.equal(verifyPassword("correct horse", "othersalt", hash), false);
});

test("normalizeUsername lowercases and validates", () => {
  assert.equal(normalizeUsername("Ben_Tehan"), "ben_tehan");
  assert.equal(normalizeUsername("  Alice99 "), "alice99");
  assert.equal(normalizeUsername("a"), null); // too short
  assert.equal(normalizeUsername("has space"), null);
  assert.equal(normalizeUsername("bad/slash"), null);
  assert.equal(normalizeUsername(42), null);
});
