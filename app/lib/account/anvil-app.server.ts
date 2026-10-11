/**
 * The Anvil app the Devforge account belongs to.
 *
 * Accounts in Anvil are global: one `auth.users` row signs in to every app on
 * the server. An app is the tenant that owns email templates, OTP settings and
 * a member list. The account pages name this app on sign-up and emailed-code
 * requests so Anvil sends the Devforge-branded emails and applies the app's
 * settings, and every successful sign-in makes sure the person is a member of
 * it, so the app's member list (Hammer > Apps > Devforge > Members) is the
 * list of Devforge accounts. Anvil's own social login enrols like this; its
 * password and code flows do not, hence this module.
 *
 * Membership is bookkeeping, not a gate: devforge.io reads and writes data as
 * its service principal, so a person removed from the app can still sign in
 * (and is enrolled again). Enrolment is best-effort and never blocks sign-in.
 */

import { AnvilError, docQuery, serviceFetch } from "../feature-requests/anvil.server";

export const DEFAULT_ACCOUNT_APP = "devforge";

const SLUG = /^[a-z][a-z0-9_-]{0,63}$/;

/** Slug of the account app: `ANVIL_APP`, or `devforge` when unset. Throws on a malformed value. */
export function accountAppSlug(): string {
  const raw = (process.env.ANVIL_APP ?? "").trim();
  const slug = raw || DEFAULT_ACCOUNT_APP;
  if (!SLUG.test(slug)) throw new AnvilError(`ANVIL_APP must be an Anvil app slug, got ${JSON.stringify(raw)}`, 500);
  return slug;
}

const APP_ID_TTL = 60 * 60 * 1000;
const MEMBER_TTL = 6 * 60 * 60 * 1000;

let appIdCache: { slug: string; id: string; expiresAt: number } | null = null;
const knownMembers = new Map<string, number>();

async function accountAppId(slug: string): Promise<string> {
  if (appIdCache && appIdCache.slug === slug && appIdCache.expiresAt > Date.now()) return appIdCache.id;
  const app = await serviceFetch<{ id?: unknown }>(`/apps/${encodeURIComponent(slug)}`);
  if (typeof app.id !== "string" || !app.id) throw new AnvilError(`Anvil did not return an id for app ${slug}`, 502);
  appIdCache = { slug, id: app.id, expiresAt: Date.now() + APP_ID_TTL };
  return app.id;
}

function remember(userId: string) {
  if (knownMembers.size > 10_000) knownMembers.clear();
  knownMembers.set(userId, Date.now() + MEMBER_TTL);
}

export type Enrolment = "enrolled" | "existing" | "failed";

/**
 * Makes `userId` (the JWT `sub`) a `reader` member of the account app unless
 * they already belong to it with any privilege: an existing admin or editor
 * is never downgraded. Pass `fresh` for an account created a moment ago to
 * skip the lookup. Errors are logged and reported, never thrown.
 */
export async function ensureAccountMember(userId: string, opts: { fresh?: boolean } = {}): Promise<Enrolment> {
  if (!userId) return "failed";
  const known = knownMembers.get(userId);
  if (known && known > Date.now()) return "existing";
  try {
    const slug = accountAppSlug();
    if (!opts.fresh) {
      const appId = await accountAppId(slug);
      const rows = await docQuery(
        "auth.app_members",
        {
          op: "and",
          conditions: [
            { op: "eq", field: "app_id", value: appId },
            { op: "eq", field: "user_id", value: userId },
          ],
        },
        1,
      );
      if (rows.length > 0) {
        remember(userId);
        return "existing";
      }
    }
    await serviceFetch(`/apps/${encodeURIComponent(slug)}/members/${encodeURIComponent(userId)}`, {
      method: "PUT",
      body: { privilege: "reader" },
    });
    remember(userId);
    return "enrolled";
  } catch (err) {
    console.error(`[account] could not enrol user ${userId} in the Anvil app: ${(err as Error).message}`);
    return "failed";
  }
}

/** Test hook: forgets the cached app id and member set. */
export function resetAccountAppCache(): void {
  appIdCache = null;
  knownMembers.clear();
}
