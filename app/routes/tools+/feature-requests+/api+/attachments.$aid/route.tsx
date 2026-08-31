/**
 * /tools/feature-requests/api/attachments/:aid (CORS)
 *
 * GET: streams the file from the private Anvil bucket. Reads are public like
 * the board; the response is nosniff, images and PDFs render inline,
 * everything else downloads.
 * DELETE: removes a still-pending upload; only its uploader (bearer token)
 * may, and files already attached to a request stay.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import type { AnvilError } from "~/lib/feature-requests/anvil.server";
import { embedUser } from "~/lib/feature-requests/embed-auth.server";
import { corsHeaders, json, preflight } from "~/lib/feature-requests/http.server";
import { getObject, isInlineType } from "~/lib/feature-requests/storage.server";
import { deletePendingAttachment, getAttachment } from "~/lib/feature-requests/store.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return preflight(request);
  try {
    const a = await getAttachment(params.aid ?? "");
    if (!a) return json({ ok: false, error: "Unknown attachment" }, { status: 404, headers: corsHeaders(request) });
    const obj = await getObject(a.storageKey);
    if (!obj) return json({ ok: false, error: "Unknown attachment" }, { status: 404, headers: corsHeaders(request) });
    const headers = corsHeaders(request);
    headers.set("Content-Type", a.mime);
    if (obj.size) headers.set("Content-Length", String(obj.size));
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
    const safeName = a.name.replace(/["\r\n\\]/g, "_");
    headers.set("Content-Disposition", `${isInlineType(a.mime) ? "inline" : "attachment"}; filename="${safeName}"`);
    headers.set("Cache-Control", "public, max-age=3600, s-maxage=86400, immutable");
    return new Response(obj.body, { status: 200, headers });
  } catch (err) {
    const e = err as AnvilError;
    return json({ ok: false, error: "Could not read the file" }, { status: e.status && e.status >= 400 ? e.status : 500, headers: corsHeaders(request) });
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return preflight(request);
  if (request.method !== "DELETE") return json({ ok: false, error: "Method not allowed" }, { status: 405, headers: corsHeaders(request) });
  const headers = corsHeaders(request);
  try {
    const user = embedUser(request);
    if (!user) return json({ ok: false, error: "Sign in first", signIn: true }, { status: 401, headers });
    const removed = await deletePendingAttachment(params.aid ?? "", user.email);
    if (!removed) return json({ ok: false, error: "This file cannot be removed" }, { status: 404, headers });
    return json({ ok: true }, { headers });
  } catch (err) {
    const e = err as AnvilError;
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    return json({ ok: false, error: status >= 500 ? "Could not remove the file" : e.message }, { status, headers });
  }
}
