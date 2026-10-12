/**
 * The slice of Stripe this app uses, over its REST API with fetch: a Checkout
 * Session to start a subscription, reading a session and a subscription back,
 * a Customer Portal session, and webhook signature verification. No SDK: the
 * surface is small, the rest of the fork talks to its services the same way,
 * and tests can stub `fetch` like they do for Anvil.
 *
 * Stripe takes form-encoded bodies with bracketed nesting
 * (`line_items[0][price]=...`); `encodeForm` produces that from a plain object.
 *
 * The Hammer price is a recurring yearly price in USD, found through
 * STRIPE_PRICE_HAMMER (a price id) or, failing that, the price with lookup key
 * `hammer_yearly` on the account.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const STRIPE_API = "https://api.stripe.com";
/**
 * Pinned on every call: the account's default version dates from 2017, and the
 * object shapes this module reads (Checkout Sessions, subscription items with
 * their own period end) are the ones this version renders. Webhook events are
 * only used for their ids; the subscription is always re-read through here.
 */
export const STRIPE_API_VERSION = "2025-08-27.basil";
export const HAMMER_PRICE_LOOKUP_KEY = "hammer_yearly";

export class StripeError extends Error {
  status: number;
  code?: string;
  type?: string;
  constructor(message: string, status = 500, extra: { code?: string; type?: string } = {}) {
    super(message);
    this.name = "StripeError";
    this.status = status;
    this.code = extra.code;
    this.type = extra.type;
  }
}

export function stripeConfig(): { secretKey: string; webhookSecret: string; priceId: string } {
  return {
    secretKey: (process.env.STRIPE_SECRET_KEY || "").trim(),
    webhookSecret: (process.env.STRIPE_WEBHOOK_SECRET || "").trim(),
    priceId: (process.env.STRIPE_PRICE_HAMMER || "").trim(),
  };
}

/** True when checkout can start (the webhook secret is checked separately, where it is used). */
export function stripeConfigured(): boolean {
  return Boolean(stripeConfig().secretKey);
}

/**
 * Where Stripe sends the buyer back to: the Checkout success and cancel URLs
 * and the Customer Portal return URL. `STRIPE_RETURN_ORIGIN` when set,
 * otherwise the origin this request arrived on (the proxy's forwarded headers
 * first), so a dev server on localhost round-trips to localhost and only the
 * production deployment names devforge.io. `PUBLIC_ORIGIN` is deliberately not
 * consulted: it describes the public site for embed snippets and emails, and
 * a test purchase must never land on the live site.
 */
export function stripeReturnOrigin(request: Request): string {
  const configured = (process.env.STRIPE_RETURN_ORIGIN ?? "").trim();
  if (configured) {
    try {
      const u = new URL(configured);
      if (u.protocol === "http:" || u.protocol === "https:") return u.origin;
    } catch {
      /* fall through to the request */
    }
    console.error(`[licensing] STRIPE_RETURN_ORIGIN is not an http(s) origin: ${JSON.stringify(configured)}; using the request origin`);
  }
  const url = new URL(request.url);
  const host = (request.headers.get("x-forwarded-host") ?? "").split(",")[0].trim();
  const proto = (request.headers.get("x-forwarded-proto") ?? "").split(",")[0].trim();
  if (host && /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) {
    return `${proto === "http" || proto === "https" ? proto : url.protocol.replace(":", "")}://${host}`;
  }
  return url.origin;
}

/* ---------------------------------------------------------------------- */
/* Transport                                                               */
/* ---------------------------------------------------------------------- */

type FormValue = string | number | boolean | null | undefined | FormValue[] | { [k: string]: FormValue };

/** Stripe's form encoding: nested objects become `a[b]`, arrays `a[0]`; null/undefined are skipped. */
export function encodeForm(params: { [k: string]: FormValue }, out = new URLSearchParams(), prefix = ""): URLSearchParams {
  for (const [key, value] of Object.entries(params)) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item === null || item === undefined) return;
        if (typeof item === "object") encodeForm(item as { [k: string]: FormValue }, out, `${name}[${i}]`);
        else out.append(`${name}[${i}]`, String(item));
      });
    } else if (typeof value === "object") {
      encodeForm(value, out, name);
    } else {
      out.append(name, String(value));
    }
  }
  return out;
}

async function stripeFetch<T>(path: string, init: { method?: "GET" | "POST" | "DELETE"; params?: { [k: string]: FormValue } } = {}): Promise<T> {
  const { secretKey } = stripeConfig();
  if (!secretKey) throw new StripeError("Payments are not configured (set STRIPE_SECRET_KEY)", 503);
  const method = init.method ?? (init.params ? "POST" : "GET");
  const headers: Record<string, string> = { authorization: `Bearer ${secretKey}`, accept: "application/json", "stripe-version": STRIPE_API_VERSION };
  let url = STRIPE_API + path;
  let body: string | undefined;
  if (init.params) {
    const form = encodeForm(init.params).toString();
    if (method === "GET") url += (url.includes("?") ? "&" : "?") + form;
    else {
      body = form;
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
  }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new StripeError(`Stripe is unreachable (${(err as Error).message})`, 503);
  }
  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: { message: text.slice(0, 200) } };
  }
  if (!res.ok) {
    const e = (data as { error?: { message?: unknown; code?: unknown; type?: unknown } }).error ?? {};
    throw new StripeError(typeof e.message === "string" && e.message ? e.message : `Stripe returned ${res.status}`, res.status, {
      code: typeof e.code === "string" ? e.code : undefined,
      type: typeof e.type === "string" ? e.type : undefined,
    });
  }
  return data as T;
}

/* ---------------------------------------------------------------------- */
/* Objects                                                                 */
/* ---------------------------------------------------------------------- */

export type CheckoutSession = {
  id: string;
  /** Where to send the customer; null once the session is complete or expired. */
  url: string | null;
  status: "open" | "complete" | "expired" | null;
  payment_status: "paid" | "unpaid" | "no_payment_required";
  mode: "payment" | "setup" | "subscription";
  subscription: string | null;
  customer: string | null;
  customer_details: { email?: string | null } | null;
  client_reference_id: string | null;
  metadata: Record<string, string>;
};

export type SubscriptionStatus = "incomplete" | "incomplete_expired" | "trialing" | "active" | "past_due" | "canceled" | "unpaid" | "paused";

export type SubscriptionItem = {
  id: string;
  quantity?: number;
  /** Present on API versions from 2025-03 onwards; older ones carry it on the subscription. */
  current_period_end?: number;
  price: { id: string; lookup_key: string | null; unit_amount: number | null; currency: string; recurring: { interval: string } | null };
};

export type Subscription = {
  id: string;
  status: SubscriptionStatus;
  customer: string;
  metadata: Record<string, string>;
  cancel_at_period_end: boolean;
  canceled_at: number | null;
  current_period_end?: number;
  items: { data: SubscriptionItem[] };
};

/** Statuses that keep the customer entitled to their keys. past_due stays on while Stripe retries the card. */
export const ENTITLED_STATUSES: ReadonlySet<SubscriptionStatus> = new Set<SubscriptionStatus>(["active", "trialing", "past_due"]);

export function subscriptionQuantity(sub: Subscription): number {
  return sub.items.data.reduce((n, item) => n + (item.quantity ?? 1), 0);
}

export function subscriptionPeriodEnd(sub: Subscription): number | null {
  const fromItem = sub.items.data.map((i) => i.current_period_end ?? 0).reduce((a, b) => Math.max(a, b), 0);
  return fromItem || sub.current_period_end || null;
}

/** Metadata this app stamps on the Checkout Session and the subscription it creates. */
export type PurchaseMetadata = { user_id: string; email: string; licensee: string; product: string };

export type CheckoutInput = {
  priceId: string;
  quantity: number;
  maxQuantity: number;
  metadata: PurchaseMetadata;
  successUrl: string;
  cancelUrl: string;
};

/** POST /v1/checkout/sessions for a subscription; the quantity stays adjustable on Stripe's page. */
export async function createCheckoutSession(input: CheckoutInput): Promise<CheckoutSession> {
  return stripeFetch<CheckoutSession>("/v1/checkout/sessions", {
    params: {
      mode: "subscription",
      line_items: [
        {
          price: input.priceId,
          quantity: input.quantity,
          adjustable_quantity: { enabled: true, minimum: 1, maximum: input.maxQuantity },
        },
      ],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      customer_email: input.metadata.email || undefined,
      client_reference_id: input.metadata.user_id,
      metadata: input.metadata,
      subscription_data: { metadata: input.metadata },
      allow_promotion_codes: true,
    },
  });
}

const STRIPE_ID = /^[A-Za-z0-9_]{1,255}$/;

function idPath(prefix: string, id: string): string {
  if (!STRIPE_ID.test(id)) throw new StripeError(`Invalid ${prefix} id`, 400);
  return `/v1/${prefix}/${id}`;
}

export async function getCheckoutSession(id: string): Promise<CheckoutSession> {
  return stripeFetch<CheckoutSession>(idPath("checkout/sessions", id));
}

export async function getSubscription(id: string): Promise<Subscription> {
  return stripeFetch<Subscription>(idPath("subscriptions", id));
}

export async function getCustomerEmail(id: string): Promise<string> {
  const c = await stripeFetch<{ email?: string | null; deleted?: boolean }>(idPath("customers", id));
  return typeof c.email === "string" ? c.email : "";
}

/** POST /v1/billing_portal/sessions: where the customer updates a card or cancels. Needs the portal enabled in the dashboard. */
export async function createPortalSession(customer: string, returnUrl: string): Promise<{ url: string }> {
  if (!STRIPE_ID.test(customer)) throw new StripeError("Invalid customer id", 400);
  return stripeFetch<{ url: string }>("/v1/billing_portal/sessions", { params: { customer, return_url: returnUrl } });
}

let priceCache: { id: string; expiresAt: number } | null = null;

/** The Hammer price id: STRIPE_PRICE_HAMMER, else the active price with lookup key `hammer_yearly` (cached 10 minutes). */
export async function resolveHammerPriceId(): Promise<string> {
  const { priceId } = stripeConfig();
  if (priceId) return priceId;
  if (priceCache && priceCache.expiresAt > Date.now()) return priceCache.id;
  const res = await stripeFetch<{ data: { id: string }[] }>("/v1/prices", {
    method: "GET",
    params: { lookup_keys: [HAMMER_PRICE_LOOKUP_KEY], active: true, limit: 1 },
  });
  const id = res.data?.[0]?.id;
  if (!id) throw new StripeError(`No active Stripe price has the lookup key ${HAMMER_PRICE_LOOKUP_KEY} (or set STRIPE_PRICE_HAMMER)`, 503);
  priceCache = { id, expiresAt: Date.now() + 10 * 60_000 };
  return id;
}

export function resetStripeCache(): void {
  priceCache = null;
}

/* ---------------------------------------------------------------------- */
/* Webhooks                                                                */
/* ---------------------------------------------------------------------- */

export type StripeEvent = {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: { object: Record<string, unknown> };
};

/**
 * Checks a `Stripe-Signature` header (`t=<unix>,v1=<hex hmac>,...`) against the
 * raw request body: HMAC-SHA256 of `<t>.<body>` with the endpoint secret, any
 * v1 may match, and the timestamp must be within `toleranceSec` of now.
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  toleranceSec = 300,
): boolean {
  if (!header || !secret) return false;
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t" && v) timestamp = v;
    else if (k === "v1" && v) signatures.push(v);
  }
  if (!/^\d+$/.test(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSec - Number(timestamp)) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  return signatures.some((sig) => {
    if (!/^[0-9a-f]+$/i.test(sig)) return false;
    const given = Buffer.from(sig, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** Verifies and parses a webhook delivery; throws StripeError(400) when it is not Stripe's. */
export function parseStripeEvent(rawBody: string, header: string | null | undefined, secret: string = stripeConfig().webhookSecret): StripeEvent {
  if (!secret) throw new StripeError("STRIPE_WEBHOOK_SECRET is not set", 503);
  if (!verifyStripeSignature(rawBody, header, secret)) throw new StripeError("Webhook signature verification failed", 400);
  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    throw new StripeError("Webhook body is not JSON", 400);
  }
  if (!event || typeof event.type !== "string" || !event.data || typeof event.data.object !== "object") {
    throw new StripeError("Webhook body is not a Stripe event", 400);
  }
  return event;
}
