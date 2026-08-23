/**
 * GET /tools/feature-requests/embed.js: the widget site owners include.
 * Served from a string so the fork needs no extra build step; cached briefly
 * at the edge, with the version as an ETag so updates roll out within minutes.
 */

import { EMBED_SCRIPT, EMBED_SCRIPT_VERSION } from "~/lib/feature-requests/embed-script";

const BODY = EMBED_SCRIPT.replace(/^[ \t]+/gm, "");
const ETAG = `"fr-embed-${EMBED_SCRIPT_VERSION}-${BODY.length}"`;

export async function loader({ request }: { request: Request }) {
  if (request.headers.get("if-none-match") === ETAG) return new Response(null, { status: 304, headers: { ETag: ETAG } });
  return new Response(BODY, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
      ETag: ETAG,
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
