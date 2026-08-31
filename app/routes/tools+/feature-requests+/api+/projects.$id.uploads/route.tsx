/**
 * POST /tools/feature-requests/api/projects/:id/uploads (CORS): upload one
 * attachment ahead of a submission. Signed-in only (bearer token). The file
 * is validated (extension, declared MIME, magic bytes, 5MB) and stored in the
 * private Anvil bucket; the returned id is passed back with the request
 * submission, which claims it. Unclaimed uploads can be deleted by their
 * uploader via DELETE /api/attachments/:aid.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import type { AnvilError } from "~/lib/feature-requests/anvil.server";
import { embedUser } from "~/lib/feature-requests/embed-auth.server";
import { clientIp, corsHeaders, json, originBlocked, preflight, rateLimited } from "~/lib/feature-requests/http.server";
import { MAX_ATTACHMENT_BYTES, putObject, validateAttachment } from "~/lib/feature-requests/storage.server";
import { createAttachment, getProject, publicAttachment } from "~/lib/feature-requests/store.server";
import { reserveUuid } from "~/lib/feature-requests/anvil.server";

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return preflight(request);
  return json({ ok: false, error: "POST a file to this endpoint" }, { status: 405, headers: corsHeaders(request) });
}

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return preflight(request);
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, { status: 405, headers: corsHeaders(request) });
  try {
    const project = await getProject(params.id ?? "");
    if (!project) return json({ ok: false, error: "Unknown project" }, { status: 404, headers: corsHeaders(request) });
    const headers = corsHeaders(request, project.origins);
    if (originBlocked(request, project.origins)) return json({ ok: false, error: "This site is not allowed to upload to this project" }, { status: 403, headers });
    const user = embedUser(request);
    if (!user) return json({ ok: false, error: "Sign in to attach files", signIn: true }, { status: 401, headers });
    if (rateLimited(`fr:upload:${clientIp(request)}`, 20, 10 * 60_000)) {
      return json({ ok: false, error: "Too many uploads, try again in a minute" }, { status: 429, headers });
    }
    const declaredLength = Number(request.headers.get("content-length")) || 0;
    if (declaredLength > MAX_ATTACHMENT_BYTES + 4096) {
      return json({ ok: false, error: "Keep attachments under 5MB." }, { status: 413, headers });
    }
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!file || typeof file === "string") return json({ ok: false, error: "Send the file as multipart form data." }, { status: 400, headers });
    const bytes = Buffer.from(await file.arrayBuffer());
    const { name, mime } = validateAttachment(file.name, file.type, bytes);
    const storageKey = `${project.id}/${await reserveUuid()}-${name}`;
    await putObject(storageKey, bytes, mime);
    const attachment = await createAttachment(project.id, { name, mime, size: bytes.length, storageKey, userId: user.id });
    return json({ ok: true, attachment: publicAttachment(attachment) }, { status: 201, headers });
  } catch (err) {
    const e = err as AnvilError;
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    return json({ ok: false, error: status >= 500 ? "Could not store the file" : e.message }, { status, headers: corsHeaders(request) });
  }
}
