import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveArticleBlocks } from "./resolve.server";
import type { ArticleIndexEntry } from "../articles.server";

const INDEX: ArticleIndexEntry[] = [
  { slug: "react-hooks", title: "React Hooks", description: "A guide", tags: ["react", "js"], headerImage: "/api/assets/hooks.png", publishedAt: "2026-06-03T00:00:00Z", updatedAt: "2026-06-03T00:00:00Z" },
  { slug: "css-grid", title: "CSS Grid", description: "Layouts", tags: ["css"], headerImage: "/api/assets/grid.png", publishedAt: "2026-06-02T00:00:00Z", updatedAt: "2026-06-02T00:00:00Z" },
  { slug: "ts-tips", title: "TS Tips", tags: ["ts", "js"], publishedAt: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z" },
  { slug: "draft-one", title: "Draft One", tags: ["react"], draft: true, publishedAt: "2026-06-04T00:00:00Z", updatedAt: "2026-06-04T00:00:00Z" },
  { slug: "xss", title: `Bad "<script>"`, description: "desc & <b>", tags: ["react"], publishedAt: "2026-05-01T00:00:00Z", updatedAt: "2026-05-01T00:00:00Z" },
];

// Mirrors production: published-only excludes drafts; include-drafts returns all.
const loadArticles = async ({ drafts }: { drafts: boolean }) =>
  drafts ? INDEX : INDEX.filter((a) => !a.draft);
const req = (u = "http://localhost/blog") => new Request(u);

test("no article placeholder → no-op", async () => {
  const html = `<h1>Hi</h1>`;
  const res = await resolveArticleBlocks(html, req(), { loadArticles });
  assert.equal(res.resolved, false);
  assert.equal(res.html, html);
});

test("grid renders published cards up to count, links to /articles/<slug>, drops the marker", async () => {
  const html = `<div data-pb-articles="grid" data-pb-count="2"></div>`;
  const res = await resolveArticleBlocks(html, req(), { loadArticles });
  assert.ok(res.resolved);
  assert.doesNotMatch(res.html, /data-pb-articles/);
  assert.doesNotMatch(res.html, /Draft One/); // drafts excluded by default
  assert.match(res.html, /href="\/articles\/react-hooks"/);
  assert.match(res.html, /React Hooks/);
  assert.match(res.html, /CSS Grid/);
  assert.doesNotMatch(res.html, /TS Tips/); // count=2 stops before it
  assert.equal(res.private, false);
});

test("include drafts shows drafts and marks the response private", async () => {
  const html = `<div data-pb-articles="grid" data-pb-drafts="include" data-pb-count="1"></div>`;
  const res = await resolveArticleBlocks(html, req(), { loadArticles });
  assert.equal(res.private, true);
  assert.match(res.html, /Draft One/); // newest overall (06-04)
});

test("?tag= filters and overrides data-pb-tag", async () => {
  const html = `<div data-pb-articles="grid" data-pb-tag="css"></div>`;
  const res = await resolveArticleBlocks(html, req("http://localhost/blog?tag=react"), { loadArticles });
  assert.match(res.html, /React Hooks/);
  assert.doesNotMatch(res.html, /CSS Grid/); // css excluded by the react query
});

test("data-pb-tag filters when there is no query", async () => {
  const html = `<div data-pb-articles="grid" data-pb-tag="css"></div>`;
  const res = await resolveArticleBlocks(html, req(), { loadArticles });
  assert.match(res.html, /CSS Grid/);
  assert.doesNotMatch(res.html, /React Hooks/);
});

test("card renders the given slug; unknown slug removes the block", async () => {
  const ok = await resolveArticleBlocks(`<div data-pb-articles="card" data-pb-slug="css-grid"></div>`, req(), { loadArticles });
  assert.match(ok.html, /CSS Grid/);
  assert.match(ok.html, /href="\/articles\/css-grid"/);

  const gone = await resolveArticleBlocks(`<div data-pb-articles="card" data-pb-slug="nope"></div><p>after</p>`, req(), { loadArticles });
  assert.doesNotMatch(gone.html, /data-pb-articles/);
  assert.match(gone.html, /<p>after<\/p>/);
});

test("featured renders a hero; image omitted when no headerImage", async () => {
  const withImg = await resolveArticleBlocks(`<div data-pb-articles="featured" data-pb-slug="react-hooks"></div>`, req(), { loadArticles });
  assert.match(withImg.html, /hooks\.png/);
  assert.match(withImg.html, /React Hooks/);

  const noImg = await resolveArticleBlocks(`<div data-pb-articles="featured" data-pb-slug="ts-tips"></div>`, req(), { loadArticles });
  assert.doesNotMatch(noImg.html, /<img/);
  assert.match(noImg.html, /TS Tips/);
});

test("tags block renders a chip per tag with the active one highlighted", async () => {
  const res = await resolveArticleBlocks(`<div data-pb-articles="tags"></div>`, req("http://localhost/blog?tag=css"), { loadArticles });
  assert.match(res.html, />All</);
  assert.match(res.html, /\?tag=css/);
  assert.match(res.html, /\?tag=react/);
  assert.match(res.html, /border-indigo-500/); // active chip
});

test("empty index → grid shows empty state; card removed", async () => {
  const empty = async () => [];
  const grid = await resolveArticleBlocks(`<div data-pb-articles="grid"></div>`, req(), { loadArticles: empty });
  assert.match(grid.html, /No articles yet/);

  const card = await resolveArticleBlocks(`<div data-pb-articles="card"></div><p>x</p>`, req(), { loadArticles: empty });
  assert.doesNotMatch(card.html, /data-pb-articles/);
  assert.match(card.html, /<p>x<\/p>/);
});

test("interpolated fields are HTML-escaped", async () => {
  const res = await resolveArticleBlocks(`<div data-pb-articles="card" data-pb-slug="xss"></div>`, req(), { loadArticles });
  assert.doesNotMatch(res.html, /<script>/);
  assert.match(res.html, /&lt;script&gt;/);
});
