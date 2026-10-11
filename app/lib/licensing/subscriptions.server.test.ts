import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fulfilCheckoutSession, reconcileSubscription, webhookSubscriptionId } from "./subscriptions.server";
import { resetLicenseStoreCache } from "./store.server";
import { resetStripeCache, type StripeEvent } from "./stripe.server";

process.env.ANVIL_URL = "https://anvil.test";
process.env.ANVIL_SERVICE_KEY = "anvil-key";
process.env.HALLMARK_URL = "https://hallmark.test";
process.env.HALLMARK_ADMIN_TOKEN = "admin-test";
process.env.STRIPE_SECRET_KEY = "sk_test_unit";

type Call = { method: string; url: string; path: string; body?: unknown; auth: string | null };
type Reply = { status?: number; body?: unknown };

/**
 * A fake Stripe + hallmark + Anvil behind one fetch: a subscription whose
 * status and quantity tests change, a hallmark that mints keys and tracks
 * activations and revocations, and a document store with conditional PUTs.
 */
function world() {
  const sub: Record<string, unknown> = {
    id: "sub_1",
    status: "active",
    customer: "cus_1",
    metadata: { user_id: "u1", email: "ben@example.com", licensee: "ben", product: "hammer" },
    cancel_at_period_end: false,
    canceled_at: null,
    items: { data: [{ id: "si_1", quantity: 2, price: { id: "price_hammer", lookup_key: "hammer_yearly", unit_amount: 10000, currency: "usd", recurring: { interval: "year" } } }] },
  };
  const session: Record<string, unknown> = {
    id: "cs_1",
    mode: "subscription",
    status: "complete",
    payment_status: "paid",
    subscription: "sub_1",
    customer: "cus_1",
    customer_details: { email: "ben@example.com" },
    client_reference_id: "u1",
    metadata: { user_id: "u1", email: "ben@example.com", licensee: "ben", product: "hammer" },
    url: null,
  };
  const licenses = new Map<string, Record<string, unknown>>();
  const activations = new Map<string, Record<string, { first_seen: number; last_seen: number }>>();
  const docs = new Map<string, Map<string, { key: string; body: Record<string, unknown>; created_at: number; updated_at: number; version: number }>>();
  const coll = (name: string) => docs.get(name) ?? docs.set(name, new Map()).get(name)!;
  let minted = 0;
  const calls: Call[] = [];
  const realFetch = globalThis.fetch;

  const handle = (c: Call): Reply => {
    // Stripe
    if (c.url.startsWith("https://api.stripe.com")) {
      assert.equal(c.auth, "Bearer sk_test_unit");
      if (c.method === "GET" && c.path === "/v1/subscriptions/sub_1") return { body: sub };
      if (c.method === "GET" && c.path === "/v1/checkout/sessions/cs_1") return { body: session };
      if (c.method === "GET" && c.path === "/v1/customers/cus_1") return { body: { id: "cus_1", email: "customer@example.com" } };
      return { status: 404, body: { error: { message: `no stripe route ${c.method} ${c.path}` } } };
    }
    // hallmark
    if (c.url.startsWith("https://hallmark.test")) {
      assert.equal(c.auth, "Bearer admin-test");
      if (c.method === "POST" && c.path === "/v1/admin/licenses") {
        const b = c.body as Record<string, unknown>;
        const id = `lic_${String(++minted).padStart(12, "0")}`;
        const rec = { v: 1, id, key: `HMR-${id}.sig`, product: b.product ?? "hammer", licensee: b.licensee, email: b.email ?? "", issued: 1_700_000_000 + minted, seats: b.seats, revoked: false, note: b.note ?? "" };
        licenses.set(id, rec);
        return { status: 201, body: rec };
      }
      const m = c.path.match(/^\/v1\/admin\/licenses\/([^/]+)(\/revoke)?$/);
      if (m) {
        const rec = licenses.get(m[1]);
        if (!rec) return { status: 404, body: { error: "no such licence" } };
        if (m[2] && c.method === "POST") {
          rec.revoked = true;
          rec.revoked_at = 1_700_009_999;
          return { body: rec };
        }
        if (c.method === "GET") {
          const acts = activations.get(m[1]) ?? {};
          return { body: { license: rec, seats_used: Object.keys(acts).length, activations: acts } };
        }
      }
      return { status: 404, body: { error: `no hallmark route ${c.method} ${c.path}` } };
    }
    // Anvil document store
    if (c.url.startsWith("https://anvil.test")) {
      assert.equal(c.auth, "Bearer anvil-key");
      const parts = c.path.replace(/^\/docs\//, "").split("/");
      const [name, rest, tail] = parts;
      if (c.method === "POST" && parts.length === 1) {
        coll(name);
        return { body: { name } };
      }
      if (c.method === "POST" && rest === "query") {
        const { filter } = c.body as { filter?: { op: string; field: string; value: unknown } };
        const all = [...coll(name).values()];
        const documents = filter ? all.filter((d) => d.body[filter.field] === filter.value) : all;
        return { body: { documents } };
      }
      if (rest !== undefined && tail === undefined) {
        const key = decodeURIComponent(rest);
        const existing = coll(name).get(key);
        if (c.method === "GET") return existing ? { body: existing } : { status: 404, body: { error: "document not found" } };
        if (c.method === "DELETE") {
          if (!existing) return { status: 404, body: { error: "document not found" } };
          coll(name).delete(key);
          return { body: { deleted: true } };
        }
        if (c.method === "PUT") {
          const b = c.body as { body: Record<string, unknown>; if_not_exists?: boolean; ttl_ms?: number };
          if (b.if_not_exists && existing) return { status: 409, body: { error: "document already exists (if_not_exists)" } };
          const now = Date.now();
          const doc = { key, body: b.body, created_at: existing?.created_at ?? now, updated_at: now, version: (existing?.version ?? 0) + 1 };
          coll(name).set(key, doc);
          return { body: doc };
        }
      }
      return { status: 404, body: { error: `no anvil route ${c.method} ${c.path}` } };
    }
    return { status: 500, body: { error: `unexpected host ${c.url}` } };
  };

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const call: Call = { method: init?.method ?? "GET", url, path: url.replace(/^https:\/\/[^/]+/, ""), body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.get("authorization") };
    calls.push(call);
    const reply = handle(call);
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  return {
    sub,
    session,
    licenses,
    activations,
    calls,
    licenseDocs: () => [...coll("app_devforge.licenses").values()].map((d) => d.body),
    lockDocs: () => coll("app_devforge.locks"),
    hallmarkCalls: () => calls.filter((c) => c.url.startsWith("https://hallmark.test")).map((c) => `${c.method} ${c.path}`),
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

type Sent = { to: string; licensee: string; keys: { id: string; key: string }[] };

beforeEach(() => {
  resetLicenseStoreCache();
  resetStripeCache();
});

test("a new active subscription gets one key per seat, recorded, emailed, and the lock is released", async () => {
  const w = world();
  try {
    const sent: Sent[] = [];
    const result = await reconcileSubscription("sub_1", { notify: async (m) => void sent.push(m) });
    assert.equal(result.busy, false);
    assert.equal(result.desired, 2);
    assert.equal(result.issued.length, 2);
    assert.equal(result.revoked.length, 0);
    assert.equal(result.notified, true);
    assert.deepEqual(w.hallmarkCalls(), ["POST /v1/admin/licenses", "POST /v1/admin/licenses"]);
    const issue = w.calls.find((c) => c.url.startsWith("https://hallmark.test"))!.body as Record<string, unknown>;
    assert.deepEqual(issue, { licensee: "ben", product: "hammer", email: "ben@example.com", seats: 1, note: "stripe sub_1" });

    const docs = w.licenseDocs();
    assert.equal(docs.length, 2);
    for (const d of docs) {
      assert.equal(d.userId, "u1");
      assert.equal(d.subscriptionId, "sub_1");
      assert.equal(d.customerId, "cus_1");
      assert.equal(d.status, "active");
      assert.match(String(d.key), /^HMR-lic_/);
    }
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "ben@example.com");
    assert.equal(sent[0].keys.length, 2);
    assert.equal(w.lockDocs().size, 0, "lock released");

    // Running again (a duplicate delivery) changes nothing.
    const again = await reconcileSubscription("sub_1", { notify: async (m) => void sent.push(m) });
    assert.equal(again.issued.length, 0);
    assert.equal(again.revoked.length, 0);
    assert.equal(again.licenses.length, 2);
    assert.equal(sent.length, 1);
    assert.equal(w.hallmarkCalls().length, 2);
  } finally {
    w.restore();
  }
});

test("reducing the quantity revokes the key with no computer on it; cancelling revokes the rest; resuming issues fresh keys", async () => {
  const w = world();
  try {
    await reconcileSubscription("sub_1", { notify: null });
    const [first, second] = [...w.licenses.keys()];
    w.activations.set(first, { "mac-1": { first_seen: 1, last_seen: 2 } });

    (w.sub.items as { data: { quantity: number }[] }).data[0].quantity = 1;
    const reduced = await reconcileSubscription("sub_1", { notify: null });
    assert.equal(reduced.desired, 1);
    assert.deepEqual(reduced.revoked.map((l) => l.id), [second], "the unused key goes first");
    assert.equal(reduced.revoked[0].revokedReason, "quantity reduced");
    assert.equal(w.licenses.get(second)?.revoked, true);
    assert.equal(w.licenses.get(first)?.revoked, false);
    assert.equal(w.licenseDocs().find((d) => d.id === second)?.status, "revoked");

    w.sub.status = "canceled";
    const cancelled = await reconcileSubscription("sub_1", { notify: null });
    assert.equal(cancelled.desired, 0);
    assert.deepEqual(cancelled.revoked.map((l) => l.id), [first]);
    assert.equal(cancelled.revoked[0].revokedReason, "subscription canceled");
    assert.equal(w.licenseDocs().filter((d) => d.status === "active").length, 0);

    // Paid again later: the revoked keys cannot come back, so a new one is minted.
    w.sub.status = "active";
    const resumed = await reconcileSubscription("sub_1", { notify: null });
    assert.equal(resumed.issued.length, 1);
    assert.equal(resumed.licenses.filter((l) => l.status === "active").length, 1);
    assert.equal(w.licenseDocs().length, 3);
  } finally {
    w.restore();
  }
});

test("past_due keeps the keys, unpaid and incomplete do not", async () => {
  const w = world();
  try {
    w.sub.status = "past_due";
    assert.equal((await reconcileSubscription("sub_1", { notify: null })).desired, 2);
    w.sub.status = "unpaid";
    const unpaid = await reconcileSubscription("sub_1", { notify: null });
    assert.equal(unpaid.desired, 0);
    assert.equal(unpaid.revoked.length, 2);
    w.sub.status = "incomplete";
    assert.equal((await reconcileSubscription("sub_1", { notify: null })).issued.length, 0);
  } finally {
    w.restore();
  }
});

test("a held lock makes the run report busy without touching hallmark; an abandoned lock is replaced", async () => {
  const w = world();
  try {
    w.lockDocs().set("sub:sub_1", { key: "sub:sub_1", body: { at: Date.now() }, created_at: 1, updated_at: 1, version: 1 });
    const busy = await reconcileSubscription("sub_1", { notify: null });
    assert.equal(busy.busy, true);
    assert.equal(busy.issued.length, 0);
    assert.equal(w.hallmarkCalls().length, 0);
    assert.equal(w.lockDocs().size, 1, "someone else's lock is left alone");

    w.lockDocs().set("sub:sub_1", { key: "sub:sub_1", body: { at: Date.now() - 10 * 60_000 }, created_at: 1, updated_at: 1, version: 1 });
    const fresh = await reconcileSubscription("sub_1", { notify: null });
    assert.equal(fresh.busy, false);
    assert.equal(fresh.issued.length, 2);
    assert.equal(w.lockDocs().size, 0);
  } finally {
    w.restore();
  }
});

test("subscriptions this site did not start, or for another product, are left alone", async () => {
  const w = world();
  try {
    w.sub.metadata = {};
    const foreign = await reconcileSubscription("sub_1", { notify: null });
    assert.match(foreign.skipped ?? "", /user_id/);
    assert.equal(w.hallmarkCalls().length, 0);

    w.sub.metadata = { user_id: "u1", product: "forge" };
    const other = await reconcileSubscription("sub_1", { notify: null });
    assert.match(other.skipped ?? "", /forge/);
    assert.equal(w.hallmarkCalls().length, 0);
  } finally {
    w.restore();
  }
});

test("when the subscription carries no email the customer's is used", async () => {
  const w = world();
  try {
    w.sub.metadata = { user_id: "u1", product: "hammer" };
    const sent: Sent[] = [];
    const result = await reconcileSubscription("sub_1", { notify: async (m) => void sent.push(m) });
    assert.equal(result.issued.length, 2);
    assert.equal(sent[0]?.to, "customer@example.com");
    assert.equal(result.issued[0].licensee, "customer@example.com");
  } finally {
    w.restore();
  }
});

test("webhookSubscriptionId maps the events this app acts on", () => {
  const ev = (type: string, object: Record<string, unknown>): StripeEvent => ({ id: "evt", type, created: 1, livemode: true, data: { object } });
  assert.equal(webhookSubscriptionId(ev("checkout.session.completed", { mode: "subscription", subscription: "sub_9" })), "sub_9");
  assert.equal(webhookSubscriptionId(ev("checkout.session.completed", { mode: "payment", subscription: null })), null);
  assert.equal(webhookSubscriptionId(ev("customer.subscription.updated", { id: "sub_8" })), "sub_8");
  assert.equal(webhookSubscriptionId(ev("customer.subscription.deleted", { id: "sub_7" })), "sub_7");
  assert.equal(webhookSubscriptionId(ev("customer.subscription.created", { id: "sub_6" })), "sub_6");
  assert.equal(webhookSubscriptionId(ev("invoice.paid", { id: "in_1", subscription: "sub_5" })), null);
});

test("fulfilCheckoutSession checks the buyer and the session state before reconciling", async () => {
  const w = world();
  try {
    const wrong = await fulfilCheckoutSession("cs_1", { expectUserId: "someone-else", notify: null });
    assert.equal(wrong.outcome, "wrong_user");
    assert.equal(w.hallmarkCalls().length, 0);

    w.session.status = "open";
    const open = await fulfilCheckoutSession("cs_1", { expectUserId: "u1", notify: null });
    assert.equal(open.outcome, "not_complete");

    w.session.status = "complete";
    const done = await fulfilCheckoutSession("cs_1", { expectUserId: "u1", notify: null });
    assert.equal(done.outcome, "fulfilled");
    assert.equal(done.result?.issued.length, 2);
    assert.equal(done.result?.licenses.filter((l) => l.status === "active").length, 2);
  } finally {
    w.restore();
  }
});
