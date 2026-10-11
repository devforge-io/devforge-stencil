/**
 * Keeps a Stripe subscription and its Hammer keys in step.
 *
 * One idempotent operation, `reconcileSubscription`, does all the work: read
 * the subscription from Stripe, work out how many keys it entitles the buyer
 * to (its quantity while active, trialing or past_due; none once cancelled or
 * unpaid), compare with the keys already issued for it, and issue or revoke
 * the difference through hallmark. The webhook, the post-checkout page and any
 * future admin tool all call the same function, so a repeated or out-of-order
 * delivery changes nothing. A per-subscription lock in Anvil stops two
 * deliveries (Stripe sends `checkout.session.completed` and
 * `customer.subscription.*` almost together) from both issuing.
 *
 * Keys never expire on their own: hallmark has no "extend" call, so a yearly
 * renewal needs no action, and a cancelled or unpaid subscription is handled
 * by revoking, which Hammer sees on its next check-in.
 */

import { HallmarkError, issueLicense, revokeLicense, showLicense } from "./hallmark.server";
import {
  ENTITLED_STATUSES,
  getCheckoutSession,
  getCustomerEmail,
  getSubscription,
  subscriptionQuantity,
  type CheckoutSession,
  type StripeEvent,
  type SubscriptionStatus,
} from "./stripe.server";
import { acquireLock, listSubscriptionLicenses, markLicenseRevoked, releaseLock, saveLicense, type OwnedLicense } from "./store.server";
import { sendLicenseKeysEmail } from "./email.server";
import { HAMMER_PLAN, HAMMER_PRODUCT, LICENSES_PATH } from "./shared";

export type Notifier = (input: { to: string; licensee: string; keys: { id: string; key: string }[] }) => Promise<unknown>;

export type ReconcileOptions = {
  /** How new keys reach the buyer; defaults to email, `null` sends nothing. */
  notify?: Notifier | null;
  /** Absolute URL of the licences page, for the email. */
  manageUrl?: string;
};

export type ReconcileResult = {
  subscriptionId: string;
  status: SubscriptionStatus | null;
  /** Keys the subscription entitles the buyer to right now. */
  desired: number;
  issued: OwnedLicense[];
  revoked: OwnedLicense[];
  /** Every key ever issued for the subscription, after this run. */
  licenses: OwnedLicense[];
  /** Another run holds the lock; nothing was changed. */
  busy: boolean;
  /** True when new keys were handed to the notifier without error. */
  notified: boolean;
  /** Why nothing was done, when that was deliberate. */
  skipped?: string;
};

export async function reconcileSubscription(subscriptionId: string, opts: ReconcileOptions = {}): Promise<ReconcileResult> {
  const lockName = `sub:${subscriptionId}`;
  if (!(await acquireLock(lockName))) {
    const licenses = await listSubscriptionLicenses(subscriptionId).catch(() => [] as OwnedLicense[]);
    return { subscriptionId, status: null, desired: 0, issued: [], revoked: [], licenses, busy: true, notified: false };
  }
  try {
    const sub = await getSubscription(subscriptionId);
    const meta = sub.metadata ?? {};
    const existing = await listSubscriptionLicenses(subscriptionId);
    const base = { subscriptionId, status: sub.status, issued: [] as OwnedLicense[], revoked: [] as OwnedLicense[], busy: false, notified: false };

    const product = meta.product || HAMMER_PRODUCT;
    if (product !== HAMMER_PRODUCT) return { ...base, desired: 0, licenses: existing, skipped: `product ${product} is not handled here` };
    const owner = meta.user_id || existing[0]?.userId || "";
    if (!owner) return { ...base, desired: 0, licenses: existing, skipped: "the subscription carries no user_id; it was not started from this site" };

    const email = meta.email || existing[0]?.email || (await getCustomerEmail(sub.customer).catch(() => ""));
    const licensee = meta.licensee || existing[0]?.licensee || email || owner;
    const desired = ENTITLED_STATUSES.has(sub.status) ? subscriptionQuantity(sub) : 0;
    const active = existing.filter((l) => l.status === "active");
    const issued: OwnedLicense[] = [];
    const revoked: OwnedLicense[] = [];

    for (let i = active.length; i < desired; i++) {
      const rec = await issueLicense({ product, licensee, email, seats: HAMMER_PLAN.seatsPerKey, note: `stripe ${subscriptionId}` });
      const now = Date.now();
      const lic: OwnedLicense = {
        id: rec.id,
        key: rec.key,
        product,
        userId: owner,
        email,
        licensee,
        seats: rec.seats ?? HAMMER_PLAN.seatsPerKey,
        subscriptionId,
        customerId: sub.customer,
        status: "active",
        issuedAt: rec.issued ? rec.issued * 1000 : now,
        updatedAt: now,
      };
      try {
        await saveLicense(lic);
      } catch (err) {
        // A key nobody can see is a key nobody should be able to use.
        await revokeLicense(rec.id).catch(() => undefined);
        throw err;
      }
      issued.push(lic);
    }

    if (active.length > desired) {
      const reason = desired === 0 ? `subscription ${sub.status}` : "quantity reduced";
      for (const lic of (await rankForRevocation(active)).slice(0, active.length - desired)) {
        try {
          await revokeLicense(lic.id);
        } catch (err) {
          if (!(err instanceof HallmarkError && err.status === 404)) throw err;
        }
        const updated = await markLicenseRevoked(lic.id, reason);
        revoked.push(updated ?? { ...lic, status: "revoked", revokedAt: Date.now(), revokedReason: reason });
      }
    }

    let notified = false;
    if (issued.length > 0 && email && opts.notify !== null) {
      const notify = opts.notify ?? defaultNotifier(opts.manageUrl);
      try {
        await notify({ to: email, licensee, keys: issued.map((l) => ({ id: l.id, key: l.key })) });
        notified = true;
      } catch (err) {
        console.error("[licensing] could not notify", email, (err as Error).message);
      }
    }

    const revokedIds = new Set(revoked.map((l) => l.id));
    const licenses = [...existing.map((l) => revoked.find((r) => r.id === l.id) ?? l), ...issued].filter(
      (l, i, arr) => arr.findIndex((x) => x.id === l.id) === i || !revokedIds.has(l.id),
    );
    return { ...base, desired, issued, revoked, licenses, notified };
  } finally {
    await releaseLock(lockName);
  }
}

/** Keys with no machine on them go first, then the newest, so a revocation disturbs as little as possible. */
async function rankForRevocation(active: OwnedLicense[]): Promise<OwnedLicense[]> {
  const used = await Promise.all(
    active.map(async (l) => {
      try {
        return (await showLicense(l.id))?.seats_used ?? 0;
      } catch {
        return 0;
      }
    }),
  );
  return active
    .map((l, i) => ({ l, used: used[i] }))
    .sort((a, b) => a.used - b.used || b.l.issuedAt - a.l.issuedAt)
    .map((x) => x.l);
}

function defaultNotifier(manageUrl?: string): Notifier {
  const origin = (process.env.PUBLIC_ORIGIN || "https://devforge.io").replace(/\/+$/, "");
  const url = manageUrl || `${origin}${LICENSES_PATH}`;
  return (input) => sendLicenseKeysEmail({ ...input, manageUrl: url });
}

/** The subscription a webhook event is about, or null for events this app ignores. */
export function webhookSubscriptionId(event: StripeEvent): string | null {
  const o = event.data.object;
  switch (event.type) {
    case "checkout.session.completed":
      return o.mode === "subscription" && typeof o.subscription === "string" && o.subscription ? o.subscription : null;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return typeof o.id === "string" && o.id ? o.id : null;
    default:
      return null;
  }
}

export type FulfilOutcome = "fulfilled" | "wrong_user" | "not_subscription" | "not_complete";

/**
 * What the post-checkout page calls: loads the session, checks it belongs to
 * the signed-in person, and reconciles its subscription so the keys are there
 * even if the webhook has not landed yet.
 */
export async function fulfilCheckoutSession(
  sessionId: string,
  opts: { expectUserId?: string } & ReconcileOptions = {},
): Promise<{ session: CheckoutSession; outcome: FulfilOutcome; result: ReconcileResult | null }> {
  const session = await getCheckoutSession(sessionId);
  const owner = session.metadata?.user_id || session.client_reference_id || "";
  if (opts.expectUserId && owner !== opts.expectUserId) return { session, outcome: "wrong_user", result: null };
  if (session.mode !== "subscription" || typeof session.subscription !== "string" || !session.subscription) {
    return { session, outcome: "not_subscription", result: null };
  }
  if (session.status !== "complete") return { session, outcome: "not_complete", result: null };
  const result = await reconcileSubscription(session.subscription, opts);
  return { session, outcome: "fulfilled", result };
}
