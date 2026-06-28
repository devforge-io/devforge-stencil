import { test } from "node:test";
import assert from "node:assert/strict";
import { abSignals, geoSignals, timeSignals } from "./signals";

test("timeSignals derives UTC fields from a fixed instant", () => {
  const t = timeSignals(new Date("2026-06-27T09:05:00.000Z"));
  assert.equal(t.hour, 9);
  assert.equal(t.minute, 5);
  assert.equal(t.day, 6); // Saturday
  assert.equal(t.date, "2026-06-27");
  assert.equal(t.iso, "2026-06-27T09:05:00.000Z");
  assert.equal(t.ts, Date.parse("2026-06-27T09:05:00.000Z"));
});

test("geoSignals reads CDN headers and decodes URL-encoded values", () => {
  const h = new Headers({
    "x-vercel-ip-country": "GB",
    "x-vercel-ip-country-region": "ENG",
    "x-vercel-ip-city": "Greater%20London",
  });
  assert.deepEqual(geoSignals(h), { country: "GB", region: "ENG", city: "Greater London" });

  const cf = new Headers({ "cf-ipcountry": "US" });
  assert.equal(geoSignals(cf).country, "US");

  assert.deepEqual(geoSignals(new Headers()), { country: null, region: null, city: null });
});

test("abSignals is deterministic and splits roughly evenly", () => {
  const a = abSignals("visitor-123");
  const b = abSignals("visitor-123");
  assert.deepEqual(a, b); // stable for a seed
  assert.ok(a.bucket >= 0 && a.bucket < 100);
  assert.equal(a.group, a.bucket < 50 ? "a" : "b");

  // distribution sanity: not absurdly lopsided over many seeds
  let aCount = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) if (abSignals(`seed-${i}`).group === "a") aCount++;
  assert.ok(aCount > N * 0.4 && aCount < N * 0.6, `unbalanced split: ${aCount}/${N}`);
});
