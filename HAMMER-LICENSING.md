# Hammer licence sales

How devforge.io sells licence keys for Hammer, the Anvil DB desktop client.
Added 2026-10-12. Code lives in `app/lib/licensing/`, the pages in
`app/routes/products+/hammer+/`, `app/routes/account+/licenses/` and
`app/routes/api+/stripe.webhook/`.

## The pieces

| Piece | Role |
| --- | --- |
| Stripe | Takes the money. One product, **Hammer**, with a yearly recurring price of US$100 per key (lookup key `hammer_yearly`). A purchase is a subscription whose quantity is the number of keys. |
| hallmark (`licensing.devforge.io:8443`) | Mints, inspects and revokes keys, tracks which machines use them. Source of truth for everything about a key. This app only calls its admin API. |
| Anvil (`app_devforge.licenses`) | Who owns which key: account id, email, Stripe subscription and customer ids, status. Hallmark has no customers and cannot list by email, so this is what the account page reads. `app_devforge.locks` holds short leases (see below). |
| Devforge account (`/account`) | Every key belongs to a signed-in Anvil user, so people can find, move and manage keys later. |

## The flow

1. `/products/hammer/purchase`: the plan and a quantity field. Sign-in is required to continue; the action creates a Stripe Checkout Session (`mode=subscription`, adjustable quantity 1 to 50) stamped with `user_id`, `email`, `licensee` and `product=hammer` in both the session's and the subscription's metadata, and redirects to Stripe.
2. Stripe returns the buyer to `/products/hammer/purchase/success?session_id=…`. The loader checks the session belongs to the signed-in account and reconciles its subscription, so the keys show at once even if the webhook is late. If another run holds the lock, the page says "confirming" and refreshes itself.
3. `/api/stripe/webhook` receives `checkout.session.completed`, `customer.subscription.created|updated|deleted`, verifies the `Stripe-Signature` header against the raw body, and reconciles the subscription named in the event. Anything else is acknowledged and ignored.
4. **Reconcile** (`subscriptions.server.ts`) is the only operation that changes anything, and it is idempotent: read the subscription from Stripe; the buyer is entitled to `quantity` keys while the status is `active`, `trialing` or `past_due`, and to none otherwise; compare with the active keys already recorded for that subscription; issue the shortfall through hallmark (`seats: 1`, `note: stripe <sub id>`), or revoke the excess (keys with no machine on them first, then the newest). New keys are emailed with the SMTP settings the contact form uses and recorded in Anvil.
5. `/account/licenses` lists the person's keys grouped by subscription, with live seat usage and machines from hallmark and the renewal date from Stripe. Actions: free a machine's seat (hallmark `DELETE …/activations/{machine}`) and open Stripe's Customer Portal for card changes and cancellation.

Keys never carry an expiry. Hallmark cannot extend a key, so a renewal needs no action, and a cancelled or unpaid subscription is handled by revoking, which Hammer sees on its next check-in (it checks on every launch and keeps a verdict for 14 days of grace when offline). `cancel_at_period_end` cancellations fire `customer.subscription.deleted` at the end of the paid year, so keys keep working until then.

### Concurrency

Stripe sends `checkout.session.completed` and the `customer.subscription.*` events almost together, and the success page may run at the same time. Each reconcile takes a lease in `app_devforge.locks` (`sub:<id>`, conditional create plus a 90 s TTL; a lease older than 90 s counts as abandoned) and the webhook answers 503 when it cannot get it, so Stripe retries later with the latest state.

## Configuration

| Variable | Meaning |
| --- | --- |
| `HALLMARK_URL` | Default `https://licensing.devforge.io:8443`. |
| `HALLMARK_ADMIN_TOKEN` | `admin_token` from `/etc/hallmark/hallmark.toml` on the licensing host. Without it the purchase page says purchasing is unavailable. |
| `HALLMARK_PUBLIC_KEY` | `GET /v1/public-key` on the service. Used only to verify keys offline (`verifyLicenseKey`). It must equal the key Hammer was built with (`HAMMER_LICENSE_PUBKEY` secret on `devforge-io/hammer-client`), or every key sold fails in the app. Never put the `signing_key` in this app. |
| `STRIPE_SECRET_KEY` | Live secret key. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the endpoint that points at `<origin>/api/stripe/webhook`. |
| `STRIPE_PRICE_HAMMER` | Optional price id; otherwise the active price with lookup key `hammer_yearly` is looked up (cached 10 minutes). |
| `STRIPE_RETURN_ORIGIN` | Where Stripe sends the buyer back to: Checkout success and cancel URLs and the Customer Portal return URL. Unset, the origin the request arrived on is used (forwarded headers first), so a dev server on localhost returns to localhost and a test purchase never lands on the live site. Set it to `https://devforge.io` on the production deployment only. |
| `PUBLIC_ORIGIN` | Used for the link in the keys email sent from the webhook (which has no browser request to take an origin from); the success page uses the return origin above. Not used for Stripe return URLs. |
| `SMTP_*` | Same as the contact form; keys are still issued and listed when mail is not configured. |

The price shown on the page is `HAMMER_PLAN` in `app/lib/licensing/shared.ts`; it is not read back from Stripe. Change both together.

## Stripe account setup

- Product **Hammer**, price US$100 / year, `lookup_key = hammer_yearly`, metadata `product=hammer`.
- Webhook endpoint `https://devforge.io/api/stripe/webhook` with events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`. Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
- Customer Portal: enable it once under Settings → Billing → Customer portal, allowing cancellation and payment-method updates. Until then "Manage billing" on the licences page reports that billing management is not switched on. Quantity changes through the portal are handled by the same reconcile (extra keys issued, surplus revoked), so only allow them if that is wanted.

## Hammer side

The desktop app's trial banner and licence screen link to `HAMMER_LICENSE_BUY_URL` (default `https://anvildb.com/pricing`). Set the repository variable to `https://devforge.io/products/hammer/purchase` before the next release.

## Operations

Refund or chargeback: Stripe does not cancel the subscription on its own. Cancel it in the dashboard (immediately, not at period end) and the `customer.subscription.deleted` event revokes the keys. To revoke by hand:

```sh
curl -H "Authorization: Bearer $HALLMARK_ADMIN_TOKEN" https://licensing.devforge.io:8443/v1/admin/licenses?product=hammer
curl -X POST -H "Authorization: Bearer $HALLMARK_ADMIN_TOKEN" https://licensing.devforge.io:8443/v1/admin/licenses/<id>/revoke
```

Hallmark's `note` on every key is `stripe <subscription id>`, and the Anvil record carries the same id, so the two can always be matched. A key revoked by hand stays `active` in Anvil until the next reconcile of its subscription; the licences page shows hallmark's view regardless.

Replaying a webhook from the Stripe dashboard is safe; so is calling the success URL again.

## Tests

`npm test` covers the Stripe form encoding and signature check, the hallmark client and offline key verification (with a throwaway Ed25519 pair), and the reconcile against a fake Stripe, hallmark and Anvil: first issue, duplicate delivery, quantity down, cancel, resume, past_due, the lock, foreign subscriptions and the success-page checks.
