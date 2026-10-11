/**
 * /account/licenses: the signed-in person's Hammer keys, grouped by Stripe
 * subscription. Ownership comes from this app's records in Anvil; the live
 * facts about each key (seats in use, which machines, revoked) come from
 * hallmark, and the renewal date from Stripe. Actions: free a machine's seat
 * (hallmark) and open Stripe's Customer Portal for billing and cancellation.
 */

import { Form, redirect, useActionData, useLoaderData, useNavigation, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { ArrowRight, KeyRound } from "lucide-react";
import { getSiteChrome } from "~/lib/site-chrome.server";
import { ensureCsrfToken, validateCsrf } from "~/lib/csrf.server";
import { CsrfInput, CsrfProvider } from "~/components/csrf-input";
import { requireAccountUser } from "~/lib/account/session.server";
import { ACCOUNT_PATH } from "~/lib/account/paths";
import { dropActivation, hallmarkConfigured, showLicense, type Activation } from "~/lib/licensing/hallmark.server";
import { StripeError, createPortalSession, getSubscription, stripeConfigured, subscriptionPeriodEnd, type SubscriptionStatus } from "~/lib/licensing/stripe.server";
import { getOwnedLicense, listUserLicenses, type OwnedLicense } from "~/lib/licensing/store.server";
import { HAMMER_PLAN, LICENSES_PATH, PURCHASE_PATH, formatDay } from "~/lib/licensing/shared";
import { LicenseKey } from "~/components/licensing/license-key";
import { Card, Notice, Shell, dangerBtn, ghostBtn, primaryBtn, primaryBtnStyle } from "~/components/tools/feature-requests/shell";

export function meta() {
  return [{ title: "Your Hammer licences · Devforge" }, { name: "robots", content: "noindex" }];
}

type Machine = { id: string; lastSeen: number; appVersion: string };
type KeyView = {
  id: string;
  key: string;
  status: "active" | "revoked";
  issuedAt: number;
  revokedAt?: number;
  revokedReason?: string;
  seats: number;
  seatsUsed: number | null;
  machines: Machine[];
};
type Group = {
  subscriptionId: string;
  customerId: string;
  status: SubscriptionStatus | null;
  periodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  keys: KeyView[];
};

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireAccountUser(request);
  const [{ token, setCookie }, chrome, owned] = await Promise.all([ensureCsrfToken(request), getSiteChrome(), listUserLicenses(user.id)]);

  let hallmarkDown = false;
  const details = await Promise.all(
    owned.map(async (l) => {
      if (!hallmarkConfigured()) return null;
      try {
        return await showLicense(l.id);
      } catch (err) {
        hallmarkDown = true;
        console.error("[licensing] could not read licence", l.id, (err as Error).message);
        return null;
      }
    }),
  );

  const subIds = [...new Set(owned.map((l) => l.subscriptionId).filter(Boolean))];
  let stripeDown = false;
  const subs = new Map<string, { status: SubscriptionStatus; periodEnd: number | null; cancelAtPeriodEnd: boolean }>();
  await Promise.all(
    subIds.map(async (id) => {
      if (!stripeConfigured()) return;
      try {
        const s = await getSubscription(id);
        subs.set(id, { status: s.status, periodEnd: subscriptionPeriodEnd(s), cancelAtPeriodEnd: s.cancel_at_period_end });
      } catch (err) {
        stripeDown = true;
        console.error("[licensing] could not read subscription", id, (err as Error).message);
      }
    }),
  );

  const groups = new Map<string, Group>();
  owned.forEach((l: OwnedLicense, i) => {
    const d = details[i];
    const machines: Machine[] = d
      ? Object.entries(d.activations as Record<string, Activation>)
          .map(([id, a]) => ({ id, lastSeen: a.last_seen * 1000, appVersion: a.app_version ?? "" }))
          .sort((a, b) => b.lastSeen - a.lastSeen)
      : [];
    const view: KeyView = {
      id: l.id,
      key: l.key,
      status: d?.license.revoked ? "revoked" : l.status,
      issuedAt: l.issuedAt,
      revokedAt: l.revokedAt ?? (d?.license.revoked_at ? d.license.revoked_at * 1000 : undefined),
      revokedReason: l.revokedReason,
      seats: l.seats,
      seatsUsed: d ? d.seats_used : null,
      machines,
    };
    const sub = subs.get(l.subscriptionId);
    const g = groups.get(l.subscriptionId) ?? {
      subscriptionId: l.subscriptionId,
      customerId: l.customerId,
      status: sub?.status ?? null,
      periodEnd: sub?.periodEnd ?? null,
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
      keys: [],
    };
    g.keys.push(view);
    groups.set(l.subscriptionId, g);
  });

  const data = {
    csrfToken: token,
    chrome,
    user: { email: user.email },
    groups: [...groups.values()],
    hallmarkDown,
    stripeDown,
  };
  return setCookie ? Response.json(data, { headers: { "Set-Cookie": setCookie } }) : data;
}

type ActionData = { error?: string; ok?: string };

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireAccountUser(request);
  const form = await request.formData();
  await validateCsrf(request, form);
  const intent = String(form.get("intent") ?? "");

  if (intent === "deactivate") {
    const id = String(form.get("license") ?? "");
    const machine = String(form.get("machine") ?? "");
    const lic = await getOwnedLicense(id, user.id);
    if (!lic) return Response.json({ error: "That key is not on your account." } satisfies ActionData, { status: 404 });
    try {
      const res = await dropActivation(lic.id, machine);
      return { ok: res.removed ? "The seat is free. Activate Hammer on the new computer with the same key." : "That computer was not using the key." } satisfies ActionData;
    } catch (err) {
      console.error("[licensing] deactivate failed", lic.id, (err as Error).message);
      return Response.json({ error: "The licence service did not accept that. Please try again shortly." } satisfies ActionData, { status: 502 });
    }
  }

  if (intent === "portal") {
    const customerId = String(form.get("customer") ?? "");
    const owned = await listUserLicenses(user.id);
    if (!customerId || !owned.some((l) => l.customerId === customerId)) {
      return Response.json({ error: "No billing account found for you." } satisfies ActionData, { status: 404 });
    }
    const origin = (process.env.PUBLIC_ORIGIN || new URL(request.url).origin).replace(/\/+$/, "");
    try {
      const portal = await createPortalSession(customerId, `${origin}${LICENSES_PATH}`);
      return redirect(portal.url, 303);
    } catch (err) {
      console.error("[licensing] portal failed", (err as Error).message);
      const notEnabled = err instanceof StripeError && err.status === 400;
      return Response.json(
        { error: notEnabled ? "Billing management is not switched on yet. Contact us to change or cancel your subscription." : "We could not open billing right now. Please try again shortly." } satisfies ActionData,
        { status: notEnabled ? 503 : 502 },
      );
    }
  }

  return Response.json({ error: "Unknown action." } satisfies ActionData, { status: 400 });
}

function statusLabel(g: Group): { text: string; tone: "ok" | "warn" | "off" } {
  if (!g.status) return { text: "Subscription", tone: "ok" };
  if (g.status === "active" || g.status === "trialing") {
    if (g.cancelAtPeriodEnd) return { text: `Cancelled, keys work until ${formatDay(g.periodEnd)}`, tone: "warn" };
    return { text: g.periodEnd ? `Active, renews ${formatDay(g.periodEnd)}` : "Active", tone: "ok" };
  }
  if (g.status === "past_due") return { text: "Payment overdue, update your card", tone: "warn" };
  return { text: `Subscription ${g.status.replace(/_/g, " ")}`, tone: "off" };
}

export default function Licenses() {
  const { chrome, csrfToken, user, groups, hallmarkDown, stripeDown } = useLoaderData<typeof loader>();
  const data = (useActionData() ?? {}) as ActionData;
  const busy = useNavigation().state === "submitting";
  const activeCount = groups.reduce((n, g) => n + g.keys.filter((k) => k.status === "active").length, 0);

  return (
    <CsrfProvider token={csrfToken}>
      <Shell chrome={chrome} backHref={ACCOUNT_PATH} backLabel="Your account" eyebrow="Hammer licences" icon={<KeyRound size={13} aria-hidden="true" />} wide>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Your Hammer licences</h1>
            <p className="mt-3 text-white/55">
              {activeCount === 0 ? "No active keys on this account yet." : `${activeCount} active ${activeCount === 1 ? "key" : "keys"} on`}{" "}
              {activeCount === 0 ? null : <span className="font-mono text-white/75">{user.email}</span>}
              {activeCount === 0 ? null : ". Each key unlocks one computer."}
            </p>
          </div>
          <a href={PURCHASE_PATH} className={primaryBtn} style={primaryBtnStyle}>
            Buy {activeCount > 0 ? "more keys" : "a licence"} <ArrowRight size={14} aria-hidden="true" />
          </a>
        </div>

        <div className="mt-6 space-y-3">
          {data.error ? <Notice>{data.error}</Notice> : null}
          {data.ok ? <Notice kind="ok">{data.ok}</Notice> : null}
          {hallmarkDown ? <Notice kind="info">The licence service is not reachable right now, so seat usage is not shown. Your keys are still listed.</Notice> : null}
          {stripeDown ? <Notice kind="info">Billing details could not be loaded right now.</Notice> : null}
        </div>

        {groups.length === 0 ? (
          <Card className="mt-8">
            <h2 className="text-base font-semibold text-white">No keys yet</h2>
            <p className="mt-2 text-sm text-white/55">
              A Hammer licence is a yearly subscription at US${HAMMER_PLAN.priceUsd} per key, one key per computer. Keys you buy appear here and are emailed to you.
            </p>
          </Card>
        ) : null}

        <div className="mt-8 space-y-6">
          {groups.map((g) => {
            const label = statusLabel(g);
            return (
              <Card key={g.subscriptionId}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/45">Subscription</div>
                    <div className={`mt-1 text-sm ${label.tone === "ok" ? "text-emerald-200" : label.tone === "warn" ? "text-[#ffd98a]" : "text-white/50"}`}>{label.text}</div>
                  </div>
                  {g.customerId ? (
                    <Form method="post">
                      <CsrfInput />
                      <input type="hidden" name="intent" value="portal" />
                      <input type="hidden" name="customer" value={g.customerId} />
                      <button type="submit" disabled={busy} className={ghostBtn}>
                        Manage billing
                      </button>
                    </Form>
                  ) : null}
                </div>

                <div className="mt-5 space-y-4">
                  {g.keys.map((k) => (
                    <div key={k.id} className={k.status === "revoked" ? "opacity-60" : ""}>
                      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/45">
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] ${
                            k.status === "active" ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200" : "border-red-400/30 bg-red-400/10 text-red-200"
                          }`}
                        >
                          {k.status === "active" ? "Active" : "Revoked"}
                        </span>
                        <span>Issued {formatDay(k.issuedAt)}</span>
                        {k.status === "active" && k.seatsUsed !== null ? (
                          <span>
                            {k.seatsUsed} of {k.seats} {k.seats === 1 ? "computer" : "computers"} in use
                          </span>
                        ) : null}
                        {k.status === "revoked" && k.revokedAt ? <span>Revoked {formatDay(k.revokedAt)}</span> : null}
                      </div>
                      <LicenseKey value={k.key} />
                      {k.status === "active" && k.machines.length > 0 ? (
                        <ul className="mt-2 divide-y divide-white/5 rounded-xl border border-white/10">
                          {k.machines.map((m) => (
                            <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5 text-sm">
                              <div className="min-w-0">
                                <div className="truncate font-mono text-xs text-white/70">{m.id}</div>
                                <div className="text-xs text-white/40">
                                  Last seen {formatDay(m.lastSeen)}
                                  {m.appVersion ? ` · Hammer ${m.appVersion}` : ""}
                                </div>
                              </div>
                              <Form method="post">
                                <CsrfInput />
                                <input type="hidden" name="intent" value="deactivate" />
                                <input type="hidden" name="license" value={k.id} />
                                <input type="hidden" name="machine" value={m.id} />
                                <button type="submit" disabled={busy} className={dangerBtn}>
                                  Free this seat
                                </button>
                              </Form>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {k.status === "active" && k.seatsUsed === 0 ? <p className="mt-2 text-xs text-white/40">Not activated on any computer yet.</p> : null}
                    </div>
                  ))}
                </div>
              </Card>
            );
          })}
        </div>
      </Shell>
    </CsrfProvider>
  );
}
