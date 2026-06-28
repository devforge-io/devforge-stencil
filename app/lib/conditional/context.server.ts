import { getSession } from "../auth.server";
import { getVisitor } from "../visitor.server";
import type { AnyContentItem } from "../content.server";
import type { ConditionContext } from "./types";
import { abSignals, geoSignals, timeSignals } from "./signals";

// Coarse mobile detection — only `mobile` vs `desktop` is exposed as a signal.
const MOBILE_UA =
  /Mobi|Android|iPhone|iPad|iPod|Windows Phone|webOS|BlackBerry|Opera Mini|IEMobile/i;

/**
 * Assemble the per-request context that conditions are evaluated against. Each
 * signal namespace is resolved from the incoming `request` (and the page being
 * served). Adding a new signal means adding a resolver here — the rule format
 * never changes.
 *
 * Signal set:
 *   - `auth.*`        — the visitor session (Phase 3), falling back to the
 *                       CMS-admin session: loggedIn, username, id, roles,
 *                       attributes.*
 *   - `query.<param>` — URL query string (always strings)
 *   - `data.<key>`    — page frontmatter `data:` object
 *   - `device`        — coarse `mobile` | `desktop` from UA
 *   - `time.*`        — UTC time-window signals (hour, day, date, …)
 *   - `geo.*`         — edge/CDN geo headers (country, region, city)
 *   - `ab.*`          — stable A/B bucket/group for the visitor
 */
export async function buildContext(
  request: Request,
  content?: AnyContentItem
): Promise<ConditionContext> {
  const url = new URL(request.url);

  // Visitor account takes precedence; CMS-admin session is the fallback so the
  // original login/profile example keeps working until visitor accounts exist.
  const visitor = await getVisitor(request).catch(() => null);
  const adminSession = await getSession(request);
  const adminUser = adminSession.get("username") as string | undefined;

  const auth: ConditionContext["auth"] = visitor
    ? {
        loggedIn: true,
        username: visitor.username,
        id: visitor.id,
        roles: visitor.roles,
        attributes: visitor.attributes,
      }
    : {
        loggedIn: !!adminUser,
        username: adminUser ?? null,
        id: adminUser ? "admin" : null,
        roles: adminUser ? ["admin"] : [],
        attributes: {},
      };

  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) query[key] = value;

  const fm = content?.frontmatter as Record<string, unknown> | undefined;
  const data =
    fm && typeof fm.data === "object" && fm.data !== null
      ? (fm.data as Record<string, unknown>)
      : {};

  const ua = request.headers.get("user-agent") ?? "";
  const device: "mobile" | "desktop" = MOBILE_UA.test(ua) ? "mobile" : "desktop";

  return {
    auth,
    query,
    data,
    device,
    time: timeSignals(new Date()),
    geo: geoSignals(request.headers),
    ab: abSignals(abSeed(request, visitor?.id, ua)),
  };
}

/** A stable seed for A/B bucketing: explicit cookie → visitor id → ip+ua. */
function abSeed(request: Request, visitorId: string | undefined, ua: string): string {
  const cookie = readCookie(request, "__stencil_ab");
  if (cookie) return cookie;
  if (visitorId) return visitorId;
  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() ||
    "anon";
  return `${ip}|${ua}`;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}
