import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAttachment, isInlineType } from "./storage.server";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

test("valid png passes and gets its extension MIME", () => {
  const r = validateAttachment("shot.PNG", "image/png", PNG);
  assert.equal(r.mime, "image/png");
  assert.equal(r.name, "shot.PNG");
});

test("executables and scripts are rejected by extension", () => {
  for (const name of ["evil.exe", "run.sh", "page.html", "img.svg", "arc.zip", "mod.js", "noext"]) {
    assert.throws(() => validateAttachment(name, "application/octet-stream", PNG), /not allowed/);
  }
});

test("a renamed executable fails the magic-byte check", () => {
  const mz = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64)]);
  assert.throws(() => validateAttachment("evil.png", "image/png", mz), /content does not match/);
});

test("binary content in a text extension is rejected", () => {
  const bin = Buffer.from([0x74, 0x00, 0x78, 0x74]);
  assert.throws(() => validateAttachment("notes.txt", "text/plain", bin), /content does not match/);
  const ok = validateAttachment("notes.txt", "text/plain", Buffer.from("hello"));
  assert.equal(ok.mime, "text/plain");
});

test("declared MIME must not contradict the extension", () => {
  assert.throws(() => validateAttachment("a.pdf", "image/png", Buffer.from("%PDF-1.4")), /does not match its name/);
});

test("oversized and empty files are rejected", () => {
  assert.throws(() => validateAttachment("a.txt", "text/plain", Buffer.alloc(0)), /empty/);
  assert.throws(() => validateAttachment("a.txt", "text/plain", Buffer.alloc(5 * 1024 * 1024 + 1, 97)), /under 5MB/);
});

test("filenames are sanitized", () => {
  const r = validateAttachment('we ird/na"me.png', "image/png", PNG);
  assert.equal(r.name.includes("/"), false);
  assert.equal(r.name.includes('"'), false);
});

test("only images and pdf render inline", () => {
  assert.equal(isInlineType("image/png"), true);
  assert.equal(isInlineType("application/pdf"), true);
  assert.equal(isInlineType("text/plain"), false);
  assert.equal(isInlineType("application/json"), false);
});
