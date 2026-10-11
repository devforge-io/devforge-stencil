/**
 * /products/hammer/purchase: buy Hammer licence keys. A yearly Stripe
 * subscription priced per key, one key per computer. The page needs a Devforge
 * account (the keys are tied to it); the action creates a Stripe Checkout
 * Session and sends the person to Stripe, which returns them to
 * /products/hammer/purchase/success. Keys are issued by the webhook or by the
 * success page, whichever runs first (subscriptions.server.ts).
 */

import { useState } from "react";
import { Form, redirect, useActionData, useLoaderData, useNavigation, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { ArrowRight, Hammer } from "lucide-react";
import { getSiteChrome } from "~/lib/site-chrome.server";
import { ensureCsrfToken, validateCsrf } from "~/lib/csrf.server";
import { CsrfInput, CsrfProvider } from "~/components/csrf-input";
import { getAccountUser, requireAccountUser } from "~/lib/account/session.server";
import { signInHref, signUpHref } from "~/lib/account/paths";
import { clientIp, rateLimited } from "~/lib/feature-requests/http.server";
import { hallmarkConfigured } from "~/lib/licensing/hallmark.server";
import { StripeError, createCheckoutSession, resolveHammerPriceId, stripeConfigured } from "~/lib/licensing/stripe.server";
import { listUserLicenses } from "~/lib/licensing/store.server";
import { HAMMER_PAGE_PATH, HAMMER_PLAN, HAMMER_PRODUCT, LICENSES_PATH, PURCHASE_PATH, PURCHASE_SUCCESS_PATH, formatUsd, parseQuantity } from "~/lib/licensing/shared";
import { Card, Field, Notice, Shell, ghostBtn, inputClass, primaryBtn, primaryBtnStyle } from "~/components/tools/feature-requests/shell";

export function meta() {
  return [
    { title: "Buy a Hammer licence · Devforge" },
    { name: "description", content: `Hammer licence keys for the desktop client: ${formatUsd(HAMMER_PLAN.priceUsd)} per key, per year. One key per computer.` },
  ];
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const user = await getAccountUser(request);
  const [{ token, setCookie }, chrome] = await Promise.all([ensureCsrfToken(request), getSiteChrome()]);
  let activeKeys = 0;
  if (user) {
    try {
      activeKeys = (await listUserLicenses(user.id)).filter((l) => l.status === "active").length;
    } catch (err) {
      console.error("[licensing] could not count keys:", (err as Error).message);
    }
  }
  const data = {
    csrfToken: token,
    chrome,
    user: user ? { email: user.email } : null,
    cancelled: url.searchParams.get("cancelled") === "1",
    available: stripeConfigured() && hallmarkConfigured(),
    activeKeys,
  };
  return setCookie ? Response.json(data, { headers: { "Set-Cookie": setCookie } }) : data;
}

type ActionData = { error?: string };

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireAccountUser(request);
  const form = await request.formData();
  await validateCsrf(request, form);
  if (rateLimited(`licensing:checkout:${clientIp(request)}`, 10, 10 * 60_000)) {
    return Response.json({ error: "Too many attempts. Try again in a few minutes." } satisfies ActionData, { status: 429 });
  }
  const quantity = parseQuantity(form.get("quantity"));
  if (!quantity) {
    return Response.json({ error: `Choose between ${HAMMER_PLAN.minKeys} and ${HAMMER_PLAN.maxKeys} keys.` } satisfies ActionData, { status: 400 });
  }
  if (!stripeConfigured() || !hallmarkConfigured()) {
    return Response.json({ error: "Purchasing is not available right now. Please try again later." } satisfies ActionData, { status: 503 });
  }
  const origin = (process.env.PUBLIC_ORIGIN || new URL(request.url).origin).replace(/\/+$/, "");
  try {
    const priceId = await resolveHammerPriceId();
    const session = await createCheckoutSession({
      priceId,
      quantity,
      maxQuantity: HAMMER_PLAN.maxKeys,
      metadata: { user_id: user.id, email: user.email, licensee: user.username || user.email, product: HAMMER_PRODUCT },
      successUrl: `${origin}${PURCHASE_SUCCESS_PATH}?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}${PURCHASE_PATH}?cancelled=1`,
    });
    if (!session.url) throw new StripeError("Stripe did not return a checkout URL", 502);
    return redirect(session.url, 303);
  } catch (err) {
    console.error("[licensing] could not start checkout:", (err as Error).message);
    const unavailable = err instanceof StripeError && err.status === 503;
    return Response.json(
      { error: unavailable ? "Purchasing is not available right now. Please try again later." : "We could not start the payment. Please try again shortly." } satisfies ActionData,
      { status: unavailable ? 503 : 500 },
    );
  }
}

export default function PurchaseHammer() {
  const { chrome, csrfToken, user, cancelled, available, activeKeys } = useLoaderData<typeof loader>();
  const data = (useActionData() ?? {}) as ActionData;
  const busy = useNavigation().state === "submitting";
  const [quantity, setQuantity] = useState(1);
  const total = quantity * HAMMER_PLAN.priceUsd;

  return (
    <CsrfProvider token={csrfToken}>
      <Shell chrome={chrome} backHref={HAMMER_PAGE_PATH} backLabel="Hammer" eyebrow="Hammer licence" icon={<Hammer size={13} aria-hidden="true" />}>
        <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Buy a Hammer licence</h1>
        <p className="mt-3 text-white/55">
          Hammer is the desktop client for Anvil DB. A licence is a yearly subscription priced per key, and each key unlocks one computer.
        </p>

        {cancelled ? (
          <div className="mt-6">
            <Notice kind="info">Payment was cancelled. Nothing was charged.</Notice>
          </div>
        ) : null}
        {activeKeys > 0 ? (
          <div className="mt-6">
            <Notice kind="info">
              You already have {activeKeys} active {activeKeys === 1 ? "key" : "keys"}.{" "}
              <a href={LICENSES_PATH} className="underline underline-offset-2">
                Manage them
              </a>{" "}
              or buy more below.
            </Notice>
          </div>
        ) : null}

        <div className="mt-8 grid gap-5 md:grid-cols-2">
          <Card>
            <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/45">Per key</div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-4xl font-semibold tracking-tight text-white">{formatUsd(HAMMER_PLAN.priceUsd)}</span>
              <span className="text-sm text-white/50">per {HAMMER_PLAN.interval}</span>
            </div>
            <ul className="mt-5 space-y-2.5 text-sm text-white/65">
              <li className="flex gap-2.5">
                <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#f5a524]" />
                One key per computer. Buy as many keys as you have machines.
              </li>
              <li className="flex gap-2.5">
                <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#f5a524]" />
                Keys are emailed to you and listed in your Devforge account.
              </li>
              <li className="flex gap-2.5">
                <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#f5a524]" />
                Moving to a new computer? Free the old one from your account and activate the new one.
              </li>
              <li className="flex gap-2.5">
                <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#f5a524]" />
                Cancel any time. Keys keep working until the end of the paid year.
              </li>
              <li className="flex gap-2.5">
                <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#f5a524]" />
                Card payment through Stripe. Prices in US dollars.
              </li>
            </ul>
          </Card>

          <Card>
            {!available ? (
              <>
                <h2 className="text-base font-semibold text-white">Not available right now</h2>
                <p className="mt-2 text-sm text-white/55">Purchasing is temporarily switched off. Please check back soon.</p>
              </>
            ) : user ? (
              <Form method="post" className="space-y-4">
                <CsrfInput />
                <h2 className="text-base font-semibold text-white">How many keys?</h2>
                <Field label="Keys" htmlFor="quantity" hint={`One per computer, up to ${HAMMER_PLAN.maxKeys}. You can still change the number on the payment page.`}>
                  <input
                    id="quantity"
                    name="quantity"
                    type="number"
                    inputMode="numeric"
                    min={HAMMER_PLAN.minKeys}
                    max={HAMMER_PLAN.maxKeys}
                    step={1}
                    required
                    value={quantity}
                    onChange={(e) => setQuantity(Math.min(HAMMER_PLAN.maxKeys, Math.max(HAMMER_PLAN.minKeys, Number(e.target.value) || HAMMER_PLAN.minKeys)))}
                    className={inputClass}
                  />
                </Field>
                <div className="flex items-baseline justify-between rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-sm">
                  <span className="text-white/55">Total per year</span>
                  <span className="font-semibold text-white">{formatUsd(total)}</span>
                </div>
                {data.error ? <Notice>{data.error}</Notice> : null}
                <button type="submit" disabled={busy} className={primaryBtn} style={primaryBtnStyle}>
                  Continue to payment <ArrowRight size={14} aria-hidden="true" />
                </button>
                <p className="text-xs text-white/40">
                  Signed in as <span className="font-mono text-white/60">{user.email}</span>. The keys will belong to this account.
                </p>
              </Form>
            ) : (
              <>
                <h2 className="text-base font-semibold text-white">Sign in to buy</h2>
                <p className="mt-2 text-sm text-white/55">Keys are tied to your Devforge account so you can find, move and manage them later.</p>
                <div className="mt-4 flex flex-wrap gap-3">
                  <a href={signInHref(PURCHASE_PATH)} className={primaryBtn} style={primaryBtnStyle}>
                    Sign in
                  </a>
                  <a href={signUpHref(PURCHASE_PATH)} className={ghostBtn}>
                    Create an account
                  </a>
                </div>
              </>
            )}
          </Card>
        </div>
      </Shell>
    </CsrfProvider>
  );
}
