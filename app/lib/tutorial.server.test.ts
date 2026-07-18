import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTutorial,
  buildTutorialRaw,
  parseChaptersJson,
  chapterSlugify,
  normalizeChapters,
} from "./tutorial.server";

test("buildTutorialRaw / parseTutorial round-trips chapters and frontmatter", () => {
  const chapters = [
    { slug: "intro", title: "Intro", body: "# Hello\n\nWelcome." },
    { slug: "setup", title: "Setup", body: "Install `foo`." },
  ];
  const raw = buildTutorialRaw({ title: "My Tutorial", description: "A guide" }, chapters);
  const parsed = parseTutorial(raw);

  assert.equal(parsed.frontmatter.title, "My Tutorial");
  assert.equal(parsed.frontmatter.description, "A guide");
  assert.equal(parsed.frontmatter.contentType, "tutorial");
  assert.deepEqual(parsed.chapters, chapters);
  assert.equal(parsed.html, "");
});

test("parseTutorial tolerates a non-JSON / empty body", () => {
  const raw = `---\ntitle: "Broken"\ncontentType: tutorial\n---\n\nnot json`;
  const parsed = parseTutorial(raw);
  assert.equal(parsed.frontmatter.title, "Broken");
  assert.deepEqual(parsed.chapters, []);
});

test("normalizeChapters derives slugs and de-duplicates them", () => {
  const out = normalizeChapters([
    { slug: "", title: "Getting Started", body: "" },
    { slug: "", title: "Getting Started", body: "" },
    { slug: "custom", title: "Custom", body: "" },
  ]);
  assert.deepEqual(
    out.map((c) => c.slug),
    ["getting-started", "getting-started-2", "custom"]
  );
});

test("normalizeChapters fills a blank title", () => {
  const out = normalizeChapters([{ slug: "", title: "", body: "x" }]);
  assert.equal(out[0].title, "Chapter 1");
  assert.equal(out[0].slug, "chapter-1");
});

test("parseChaptersJson parses valid JSON and rejects garbage", () => {
  const json = JSON.stringify([{ slug: "a", title: "A", body: "1" }]);
  assert.deepEqual(parseChaptersJson(json), [{ slug: "a", title: "A", body: "1" }]);
  assert.deepEqual(parseChaptersJson("not json"), []);
  assert.deepEqual(parseChaptersJson(""), []);
  assert.deepEqual(parseChaptersJson(undefined), []);
});

test("chapterSlugify kebab-cases titles", () => {
  assert.equal(chapterSlugify("Hello, World!"), "hello-world");
  assert.equal(chapterSlugify("  Trim  Me  "), "trim-me");
});
