import { test } from "node:test";
import assert from "node:assert/strict";
import { selectUnpublishedChanges, publishEach } from "./publish-all";

const items = [
  { slug: "home", published: true, upToDate: true },
  { slug: "hammer", published: true, upToDate: false },
  { slug: "new-draft", published: false, upToDate: false },
  { slug: "tools", published: true, upToDate: false },
];

test("selectUnpublishedChanges keeps only published items whose draft moved on", () => {
  assert.deepEqual(
    selectUnpublishedChanges(items).map((i) => i.slug),
    ["hammer", "tools"],
  );
});

test("publishEach runs one at a time, in order, and carries on after a failure", async () => {
  const order: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const outcome = await publishEach(selectUnpublishedChanges(items), async (item) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight -= 1;
    order.push(item.slug);
    if (item.slug === "hammer") throw new Error("boom");
  });
  assert.deepEqual(order, ["hammer", "tools"]);
  assert.equal(maxInFlight, 1);
  assert.deepEqual(outcome.published.map((i) => i.slug), ["tools"]);
  assert.deepEqual(outcome.failed.map((f) => [f.item.slug, f.error]), [["hammer", "boom"]]);
});

test("publishEach reports non-Error throws as text", async () => {
  const outcome = await publishEach([items[1]], async () => {
    throw "nope";
  });
  assert.deepEqual(outcome.failed.map((f) => f.error), ["nope"]);
});
