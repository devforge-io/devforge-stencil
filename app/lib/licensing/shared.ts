/**
 * Client-safe constants for the Hammer licence purchase flow. No server-only
 * imports here: route components build links and copy from this module.
 *
 * The plan is a yearly Stripe subscription, priced per key; each key is one
 * seat, so one key per computer. If the Stripe price changes, change the
 * figures here too, the page copy is not read back from Stripe.
 */

export const HAMMER_PRODUCT = "hammer";
export const HAMMER_PAGE_PATH = "/products/hammer";
export const PURCHASE_PATH = "/products/hammer/purchase";
export const PURCHASE_SUCCESS_PATH = `${PURCHASE_PATH}/success`;
export const LICENSES_PATH = "/account/licenses";

export const HAMMER_PLAN = {
  name: "Hammer",
  priceUsd: 100,
  interval: "year",
  minKeys: 1,
  maxKeys: 50,
  seatsPerKey: 1,
} as const;

export type OwnedLicenseStatus = "active" | "revoked";

export function formatUsd(amount: number): string {
  return `US$${amount.toLocaleString("en-US")}`;
}

/** The number of keys a form asked for, clamped to the plan's range; null when not a number. */
export function parseQuantity(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isFinite(n)) return null;
  if (n < HAMMER_PLAN.minKeys || n > HAMMER_PLAN.maxKeys) return null;
  return n;
}

/** Unix seconds (Stripe) or ms (ours) to a readable date. */
export function formatDay(value: number | null | undefined): string {
  if (!value) return "";
  const ms = value < 1e12 ? value * 1000 : value;
  try {
    return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}
