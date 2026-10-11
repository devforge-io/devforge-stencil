/**
 * POST /api/stripe/webhook: Stripe's events for the Hammer subscriptions.
 *
 * The raw body is read as text because the signature covers the exact bytes.
 * Every event this app cares about resolves to a subscription id, and the
 * handler simply reconciles that subscription; the reconcile is idempotent, so
 * retries and duplicate deliveries are harmless. Non-2xx answers make Stripe
 * retry (with backoff, for up to three days), which is what we want when a
 * dependency is down or another delivery holds the lock.
 */

import type { ActionFunctionArgs } from "react-router";
import { StripeError, parseStripeEvent } from "~/lib/licensing/stripe.server";
import { reconcileSubscription, webhookSubscriptionId } from "~/lib/licensing/subscriptions.server";

const json = (data: unknown, status = 200) => Response.json(data, { status });

export function loader() {
  return json({ error: "POST only" }, 405);
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  const raw = await request.text();
  let event;
  try {
    event = parseStripeEvent(raw, request.headers.get("stripe-signature"));
  } catch (err) {
    const status = err instanceof StripeError ? err.status : 400;
    return json({ error: (err as Error).message }, status);
  }

  const subscriptionId = webhookSubscriptionId(event);
  if (!subscriptionId) return json({ received: true, ignored: event.type });

  try {
    const result = await reconcileSubscription(subscriptionId);
    if (result.busy) return json({ error: "another delivery for this subscription is being processed; retry" }, 503);
    return json({
      received: true,
      event: event.id,
      subscription: subscriptionId,
      status: result.status,
      desired: result.desired,
      issued: result.issued.length,
      revoked: result.revoked.length,
      skipped: result.skipped,
    });
  } catch (err) {
    console.error("[licensing] webhook", event.type, event.id, (err as Error).message);
    return json({ error: "processing failed; retry" }, 500);
  }
}
