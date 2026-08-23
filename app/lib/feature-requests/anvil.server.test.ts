import { test } from "node:test";
import assert from "node:assert/strict";
import { lit, mapLit, setLit, ident, newId, decodeJwt } from "./anvil.server";

const ZW = "​";

test("lit encodes scalars", () => {
  assert.equal(lit(null), "null");
  assert.equal(lit(undefined), "null");
  assert.equal(lit(true), "true");
  assert.equal(lit(42), "42");
  assert.equal(lit(Number.NaN), "null");
  assert.equal(lit({ a: 1 }), "null");
  assert.equal(lit("plain"), '"plain"');
});

test("lit escapes quotes, backslashes and whitespace controls", () => {
  assert.equal(lit('say "hi"'), '"say \\"hi\\""');
  assert.equal(lit("back\\slash"), '"back\\\\slash"');
  assert.equal(lit("a\nb\tc\r"), '"a\\nb\\tc\\r"');
  assert.equal(lit("bellx"), '"bellx"');
});

test("lit avoids the escaped-quote-then-comment lexer bug", () => {
  // a double quote followed by // switches the literal to single quotes
  assert.equal(lit('see "https://x" ok'), "'see \"https://x\" ok'");
  // a single quote followed by // keeps double quotes
  assert.equal(lit("it's https://x"), '"it\'s https://x"');
  // both kinds before a comment opener: the opener is split with a zero-width space
  const both = lit(`it's "quoted" https://x and /* c */`);
  assert.ok(both.startsWith('"') && both.endsWith('"'));
  assert.ok(!both.includes("//") && !both.includes("/*"));
  assert.ok(both.includes(`/${ZW}/`) && both.includes(`/${ZW}*`));
});

test("mapLit and setLit build fragments and skip undefined", () => {
  assert.equal(mapLit({ id: "a", n: 1, skip: undefined, ok: false }), '{id: "a", n: 1, ok: false}');
  assert.equal(setLit("p", { name: "x", n: 2 }), 'SET p.name = "x", p.n = 2');
  assert.equal(setLit("p", {}), "");
  assert.throws(() => mapLit({ "bad key": 1 }));
});

test("ident accepts safe ids and rejects the rest", () => {
  assert.equal(ident("abc_DEF-123"), "abc_DEF-123");
  assert.throws(() => ident('a"b'));
  assert.throws(() => ident(""));
  assert.throws(() => ident("x".repeat(65)));
  assert.throws(() => ident(12));
});

test("newId has the requested length and alphabet", () => {
  const id = newId(20);
  assert.equal(id.length, 20);
  assert.match(id, /^[A-Za-z0-9]+$/);
  assert.notEqual(newId(), newId());
});

test("decodeJwt reads the payload without verifying", () => {
  const payload = Buffer.from(JSON.stringify({ sub: "u1", email: "a@b.c" })).toString("base64url");
  assert.deepEqual(decodeJwt(`h.${payload}.s`), { sub: "u1", email: "a@b.c" });
  assert.deepEqual(decodeJwt("garbage"), {});
});
