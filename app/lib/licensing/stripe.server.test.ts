import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  HAMMER_PRICE_LOOKUP_KEY,
  STRIPE_API_VERSION,
  StripeError,
  createCheckoutSession,
  encodeForm,
  getSubscription,
  parseStripeEvent,
  resetStripeCache,
  resolveHammerPriceId,
  stripeReturnOrigin,
  subscriptionPeriodEnd,
  subscriptionQuantity,
  verifyStripeSignature,
} from "./stripe.server";

process.env.STRIPE_SECRET_KEY = "sk_test_unit";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_unit";

type Call = { method: string; url: string; body: string; auth: string | null; contentType: string | null; version: string | null };
type Reply = { status?: number; body?: unknown };

const realFetch = globalThis.fetch;

function stubFetch(handler: (call: Call) => Reply): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = { method: init?.method ?? "GET", url: String(input), body: String(init?.body ?? ""), auth: headers.get("authorization"), contentType: headers.get("content-type"), version: headers.get("stripe-version") };
    calls.push(call);
    const reply = handler(call);
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

beforeEach(() => {
  globalThis.fetch = realFetch;
  resetStripeCache();
  process.env.STRIPE_PRICE_HAMMER = "price_hammer_unit";
});

test("encodeForm writes Stripe's bracketed nesting and skips empty values", () => {
  const form = encodeForm({
    mode: "subscription",
    line_items: [{ price: "price_1", quantity: 2, adjustable_quantity: { enabled: true, minimum: 1, maximum: 50 } }],
    metadata: { user_id: "u1", note: undefined },
    customer_email: null,
  });
  const pairs = [...form.entries()];
  assert.deepEqual(pairs, [
    ["mode", "subscription"],
    ["line_items[0][price]", "price_1"],
    ["line_items[0][quantity]", "2"],
    ["line_items[0][adjustable_quantity][enabled]", "true"],
    ["line_items[0][adjustable_quantity][minimum]", "1"],
    ["line_items[0][adjustable_quantity][maximum]", "50"],
    ["metadata[user_id]", "u1"],
  ]);
});

test("createCheckoutSession posts a subscription checkout with the purchase metadata on both objects", async () => {
  const calls = stubFetch((c) => {
    if (c.method === "POST" && c.url === "https://api.stripe.com/v1/checkout/sessions") return { body: { id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1", status: "open", mode: "subscription" } };
    return { status: 404, body: { error: { message: "no route" } } };
  });
  const meta = { user_id: "u1", email: "ben@example.com", licensee: "ben", product: "hammer" };
  const session = await createCheckoutSession({
    priceId: "price_hammer_unit",
    quantity: 3,
    maxQuantity: 50,
    metadata: meta,
    successUrl: "https://devforge.io/products/hammer/purchase/success?session_id={CHECKOUT_SESSION_ID}",
    cancelUrl: "https://devforge.io/products/hammer/purchase?cancelled=1",
  });
  assert.equal(session.url, "https://checkout.stripe.com/c/pay/cs_1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].auth, "Bearer sk_test_unit");
  assert.equal(calls[0].version, STRIPE_API_VERSION, "every call pins the API version");
  assert.equal(calls[0].contentType, "application/x-www-form-urlencoded");
  const body = new URLSearchParams(calls[0].body);
  assert.equal(body.get("mode"), "subscription");
  assert.equal(body.get("line_items[0][price]"), "price_hammer_unit");
  assert.equal(body.get("line_items[0][quantity]"), "3");
  assert.equal(body.get("line_items[0][adjustable_quantity][maximum]"), "50");
  assert.equal(body.get("success_url"), "https://devforge.io/products/hammer/purchase/success?session_id={CHECKOUT_SESSION_ID}");
  assert.equal(body.get("customer_email"), "ben@example.com");
  assert.equal(body.get("client_reference_id"), "u1");
  assert.equal(body.get("metadata[product]"), "hammer");
  assert.equal(body.get("subscription_data[metadata][user_id]"), "u1");
  assert.equal(body.get("subscription_data[metadata][licensee]"), "ben");
});

test("Stripe errors keep their status and code; unknown prices are refused", async () => {
  stubFetch(() => ({ status: 402, body: { error: { message: "Your card was declined.", code: "card_declined", type: "card_error" } } }));
  await assert.rejects(getSubscription("sub_1"), (e: unknown) => e instanceof StripeError && e.status === 402 && e.code === "card_declined" && /declined/.test(e.message));
  await assert.rejects(getSubscription("sub 1"), (e: unknown) => e instanceof StripeError && e.status === 400);
});

test("resolveHammerPriceId prefers the environment and otherwise looks the price up by lookup key, once", async () => {
  assert.equal(await resolveHammerPriceId(), "price_hammer_unit");
  delete process.env.STRIPE_PRICE_HAMMER;
  resetStripeCache();
  const calls = stubFetch((c) => {
    if (c.method === "GET" && c.url.startsWith("https://api.stripe.com/v1/prices?")) {
      const q = new URL(c.url).searchParams;
      assert.equal(q.get("lookup_keys[0]"), HAMMER_PRICE_LOOKUP_KEY);
      assert.equal(q.get("active"), "true");
      return { body: { data: [{ id: "price_from_lookup" }] } };
    }
    return { status: 404, body: { error: { message: "no route" } } };
  });
  assert.equal(await resolveHammerPriceId(), "price_from_lookup");
  assert.equal(await resolveHammerPriceId(), "price_from_lookup");
  assert.equal(calls.length, 1);
  resetStripeCache();
  stubFetch(() => ({ body: { data: [] } }));
  await assert.rejects(resolveHammerPriceId(), (e: unknown) => e instanceof StripeError && e.status === 503 && /hammer_yearly/.test(e.message));
});

function signed(body: string, secret: string, t: number): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

test("verifyStripeSignature accepts a fresh, matching v1 signature and nothing else", () => {
  const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: {} } });
  const now = 1_800_000_000;
  const header = signed(body, "whsec_unit", now);
  assert.equal(verifyStripeSignature(body, header, "whsec_unit", now), true);
  assert.equal(verifyStripeSignature(body, header, "whsec_unit", now + 299), true);
  assert.equal(verifyStripeSignature(body, header, "whsec_unit", now + 301), false, "stale timestamp");
  assert.equal(verifyStripeSignature(body + " ", header, "whsec_unit", now), false, "body changed");
  assert.equal(verifyStripeSignature(body, header, "whsec_other", now), false, "other secret");
  assert.equal(verifyStripeSignature(body, header.replace("v1=", "v0="), "whsec_unit", now), false, "no v1");
  assert.equal(verifyStripeSignature(body, null, "whsec_unit", now), false);
  assert.equal(verifyStripeSignature(body, header, "", now), false);
  const twoSigs = `${header},v1=${"0".repeat(64)}`;
  assert.equal(verifyStripeSignature(body, twoSigs, "whsec_unit", now), true, "any v1 may match");
});

test("parseStripeEvent verifies before parsing and rejects non-events", () => {
  const body = JSON.stringify({ id: "evt_1", type: "customer.subscription.deleted", created: 1, livemode: true, data: { object: { id: "sub_1" } } });
  const now = Math.floor(Date.now() / 1000);
  const event = parseStripeEvent(body, signed(body, "whsec_unit", now));
  assert.equal(event.type, "customer.subscription.deleted");
  assert.equal(event.data.object.id, "sub_1");
  assert.throws(() => parseStripeEvent(body, signed(body, "whsec_wrong", now)), (e: unknown) => e instanceof StripeError && e.status === 400);
  const notEvent = JSON.stringify({ hello: "world" });
  assert.throws(() => parseStripeEvent(notEvent, signed(notEvent, "whsec_unit", now)), /not a Stripe event/);
  assert.throws(() => parseStripeEvent(body, signed(body, "whsec_unit", now), ""), (e: unknown) => e instanceof StripeError && e.status === 503);
});

test("subscription helpers sum quantities and find the period end on either API shape", () => {
  const sub = {
    id: "sub_1",
    status: "active" as const,
    customer: "cus_1",
    metadata: {},
    cancel_at_period_end: false,
    canceled_at: null,
    items: {
      data: [
        { id: "si_1", quantity: 2, current_period_end: 1_900_000_000, price: { id: "p", lookup_key: null, unit_amount: 10000, currency: "usd", recurring: { interval: "year" } } },
        { id: "si_2", price: { id: "p2", lookup_key: null, unit_amount: 1, currency: "usd", recurring: null } },
      ],
    },
  };
  assert.equal(subscriptionQuantity(sub), 3);
  assert.equal(subscriptionPeriodEnd(sub), 1_900_000_000);
  assert.equal(subscriptionPeriodEnd({ ...sub, current_period_end: 5, items: { data: [{ id: "si", quantity: 1, price: sub.items.data[0].price }] } }), 5);
});

test("stripeReturnOrigin: STRIPE_RETURN_ORIGIN wins, else the request's own origin, never PUBLIC_ORIGIN", () => {
  const prev = { ret: process.env.STRIPE_RETURN_ORIGIN, pub: process.env.PUBLIC_ORIGIN };
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    process.env.PUBLIC_ORIGIN = "https://devforge.io";
    delete process.env.STRIPE_RETURN_ORIGIN;
    const local = new Request("http://localhost:5174/products/hammer/purchase", { method: "POST" });
    assert.equal(stripeReturnOrigin(local), "http://localhost:5174");

    // behind Vercel's proxy the forwarded headers name the public host
    const proxied = new Request("http://10.0.0.5/products/hammer/purchase", {
      headers: { "x-forwarded-host": "devforge.io, internal", "x-forwarded-proto": "https" },
    });
    assert.equal(stripeReturnOrigin(proxied), "https://devforge.io");
    const badHost = new Request("http://localhost:5174/x", { headers: { "x-forwarded-host": "evil.example/%0d" } });
    assert.equal(stripeReturnOrigin(badHost), "http://localhost:5174");

    process.env.STRIPE_RETURN_ORIGIN = "https://devforge.io/";
    assert.equal(stripeReturnOrigin(local), "https://devforge.io");
    process.env.STRIPE_RETURN_ORIGIN = "http://127.0.0.1:5199/some/path";
    assert.equal(stripeReturnOrigin(proxied), "http://127.0.0.1:5199");
    process.env.STRIPE_RETURN_ORIGIN = "devforge.io";
    assert.equal(stripeReturnOrigin(local), "http://localhost:5174");
    assert.match(logged.join("\n"), /STRIPE_RETURN_ORIGIN is not an http\(s\) origin/);
  } finally {
    console.error = realError;
    if (prev.ret === undefined) delete process.env.STRIPE_RETURN_ORIGIN;
    else process.env.STRIPE_RETURN_ORIGIN = prev.ret;
    if (prev.pub === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = prev.pub;
  }
});
