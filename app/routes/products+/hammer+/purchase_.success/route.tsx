/**
 * /products/hammer/purchase/success?session_id=...: where Stripe returns the
 * buyer. Reads the Checkout Session back, checks it belongs to the signed-in
 * account, and reconciles its subscription so the keys exist whether or not
 * the webhook has arrived yet. If another run holds the lock the page shows a
 * "confirming" state and refreshes itself.
 */

import { redirect, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { ArrowRight, Hammer } from "lucide-react";
import { getSiteChrome } from "~/lib/site-chrome.server";
import { requireAccountUser } from "~/lib/account/session.server";
import { fulfilCheckoutSession } from "~/lib/licensing/subscriptions.server";
import { stripeReturnOrigin } from "~/lib/licensing/stripe.server";
import { LICENSES_PATH, PURCHASE_PATH } from "~/lib/licensing/shared";
import { LicenseKey } from "~/components/licensing/license-key";
import { Card, Notice, Shell, ghostBtn, primaryBtn, primaryBtnStyle } from "~/components/tools/feature-requests/shell";

export function meta() {
  return [{ title: "Your Hammer licence · Devforge" }, { name: "robots", content: "noindex" }];
}

type State = "keys" | "confirming" | "not_complete" | "wrong_user" | "error";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireAccountUser(request);
  const url = new URL(request.url);
  const sessionId = (url.searchParams.get("session_id") ?? "").trim();
  if (!sessionId || !/^[A-Za-z0-9_]{1,255}$/.test(sessionId)) throw redirect(PURCHASE_PATH);
  const origin = stripeReturnOrigin(request);
  const chrome = await getSiteChrome();

  let state: State = "error";
  let keys: { id: string; key: string }[] = [];
  let emailed = false;
  try {
    const { outcome, result } = await fulfilCheckoutSession(sessionId, { expectUserId: user.id, manageUrl: `${origin}${LICENSES_PATH}` });
    if (outcome === "wrong_user") state = "wrong_user";
    else if (outcome === "not_complete" || outcome === "not_subscription") state = "not_complete";
    else if (result) {
      keys = result.licenses.filter((l) => l.status === "active").map((l) => ({ id: l.id, key: l.key }));
      emailed = result.notified;
      state = keys.length > 0 ? "keys" : "confirming";
    }
  } catch (err) {
    console.error("[licensing] success page could not fulfil", sessionId, (err as Error).message);
  }
  return { chrome, state, keys, emailed, email: user.email };
}

export default function PurchaseSuccess() {
  const { chrome, state, keys, emailed, email } = useLoaderData<typeof loader>();
  return (
    <Shell chrome={chrome} backHref={LICENSES_PATH} backLabel="Your licences" eyebrow="Hammer licence" icon={<Hammer size={13} aria-hidden="true" />}>
      {state === "confirming" ? <meta httpEquiv="refresh" content="5" /> : null}

      {state === "keys" ? (
        <>
          <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Thank you. {keys.length === 1 ? "Here is your key." : "Here are your keys."}</h1>
          <p className="mt-3 text-white/55">
            In Hammer open <span className="text-white/80">Settings</span>, then <span className="text-white/80">Licence</span>, and paste a key. Each key unlocks one computer.
            {emailed ? (
              <>
                {" "}
                A copy is on its way to <span className="font-mono text-white/75">{email}</span>.
              </>
            ) : null}
          </p>
          <div className="mt-8 space-y-4">
            {keys.map((k, i) => (
              <LicenseKey key={k.id} value={k.key} label={keys.length > 1 ? `Key ${i + 1} of ${keys.length}` : undefined} />
            ))}
          </div>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href={LICENSES_PATH} className={primaryBtn} style={primaryBtnStyle}>
              Manage your licences <ArrowRight size={14} aria-hidden="true" />
            </a>
            <a href="https://github.com/anvildb/hammer/releases/latest" className={ghostBtn} rel="noopener">
              Download Hammer
            </a>
          </div>
        </>
      ) : null}

      {state === "confirming" ? (
        <>
          <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Confirming your payment</h1>
          <p className="mt-3 text-white/55">Stripe has accepted the payment and your keys are being issued. This page refreshes itself; it usually takes a few seconds.</p>
          <div className="mt-8">
            <a href={LICENSES_PATH} className={ghostBtn}>
              Go to your licences
            </a>
          </div>
        </>
      ) : null}

      {state === "not_complete" ? (
        <>
          <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Payment not completed</h1>
          <p className="mt-3 text-white/55">This checkout was not finished, so no keys were issued and nothing was charged.</p>
          <div className="mt-8">
            <a href={PURCHASE_PATH} className={primaryBtn} style={primaryBtnStyle}>
              Try again
            </a>
          </div>
        </>
      ) : null}

      {state === "wrong_user" ? (
        <>
          <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Not your purchase</h1>
          <Card className="mt-6">
            <Notice>This checkout belongs to a different Devforge account. Sign in with the account you used to pay, then open your licences.</Notice>
          </Card>
        </>
      ) : null}

      {state === "error" ? (
        <>
          <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">We could not load your purchase</h1>
          <Card className="mt-6">
            <Notice>
              Something went wrong reading the payment back. If you were charged, your keys will appear under your licences shortly, and Stripe will retry on its own. If
              they do not, contact us with the email you paid with.
            </Notice>
            <div className="mt-4">
              <a href={LICENSES_PATH} className={ghostBtn}>
                Your licences
              </a>
            </div>
          </Card>
        </>
      ) : null}
    </Shell>
  );
}
