import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeDetails } from "./details";

test("script tags are stripped, loose angle brackets escaped", () => {
  const r = sanitizeDetails("line one\nuses <script>alert(1)</script> & 2 > 1");
  assert.equal(r.html.includes("<script"), false);
  assert.ok(r.html.includes("alert(1)"), "inner text kept");
  assert.ok(r.html.includes("&amp;"));
  assert.ok(r.html.includes("2 &gt; 1"));
  assert.ok(r.text.includes("line one\n"));
});

test("allowlisted tags survive, attributes are dropped", () => {
  const r = sanitizeDetails('<p onclick="x()">Hi <b class="y">there</b></p><ul><li>one</li></ul>');
  assert.equal(r.html, "<p>Hi <b>there</b></p><ul><li>one</li></ul>");
  assert.equal(r.text, "Hi there\none");
});

test("disallowed tags are stripped but keep their text", () => {
  const r = sanitizeDetails('<img src=x onerror=alert(1)><a href="javascript:x">link</a><h1>big</h1>');
  assert.equal(r.html, "linkbig");
});

test("unbalanced markup is balanced and strike becomes s", () => {
  const r = sanitizeDetails("<b><i>both</b> <strike>old</strike>");
  assert.equal(r.html, "<b><i>both</i></b> <s>old</s>");
});

test("br is void and empty edge blocks are trimmed", () => {
  const r = sanitizeDetails("<div><br></div><p>kept</p><div></div>");
  assert.equal(r.html, "<p>kept</p>");
  assert.equal(sanitizeDetails("<div><br></div>").html, "");
});
