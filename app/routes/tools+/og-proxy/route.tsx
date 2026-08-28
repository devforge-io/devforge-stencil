/**
 * Image proxy for audit previews.
 *
 * The app's CSP sets `img-src 'self' data: blob: ...`, so the social-preview
 * cards cannot load og:image URLs from the audited site directly. This resource
 * route re-serves them from our own origin.
 *
 * It reuses the audit fetcher's SSRF guard - without that, this endpoint would
 * be an open proxy into any network the server can reach.
 */

import type { Route } from "./+types/route";
import { assertPublicHttpUrl } from "~/lib/audit/fetch.server";

/** Only formats a browser will render in an <img>. No SVG - it can carry script. */
const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 8000;

function blank(status: number): Response {
  // A transparent 1x1 GIF, so a failed proxy degrades to an empty box rather
  // than a broken-image icon; the card's onError handler takes over from there.
  const gif = Uint8Array.from(
    atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
    (c) => c.charCodeAt(0),
  );
  return new Response(gif, {
    status,
    headers: {
      "Content-Type": "image/gif",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function loader({ request }: Route.LoaderArgs) {
  const target = new URL(request.url).searchParams.get("url");
  if (!target) return blank(400);

  const guard = await assertPublicHttpUrl(target);
  if (!guard.ok) return blank(403);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const upstream = await fetch(guard.url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        Accept: "image/*",
        "User-Agent": "Mozilla/5.0 (compatible; DevforgeAudit/1.0)",
        From: "https://devforge.io/tools/website-audit",
      },
    });

    if (!upstream.ok || !upstream.body) return blank(502);

    const contentType = (upstream.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!ALLOWED_TYPES.has(contentType)) return blank(415);

    const declared = Number(upstream.headers.get("content-length") ?? "0");
    if (declared > MAX_BYTES) return blank(413);

    const buffer = await upstream.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) return blank(413);

    return new Response(buffer, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(buffer.byteLength),
        // Audited pages change rarely within a session; cache briefly so
        // re-rendering the report doesn't re-fetch every card image.
        "Cache-Control": "public, max-age=600",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  } catch {
    return blank(504);
  } finally {
    clearTimeout(timer);
  }
}
