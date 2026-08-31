/**
 * /tools/feature-requests/p/:id/r/:rid: one request on its own page. Room to
 * read the whole idea, vote, and, for the person who submitted it (same
 * email), edit the details to build it out. Works without JavaScript.
 */

import { Form, useActionData, useLoaderData, useNavigation, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { createCookie } from "react-router";
import { ChevronUp } from "lucide-react";
import { getSiteChrome } from "~/lib/site-chrome.server";
import { ensureCsrfToken, validateCsrf } from "~/lib/csrf.server";
import { CsrfInput, CsrfProvider } from "~/components/csrf-input";
import { newId, type AnvilError } from "~/lib/feature-requests/anvil.server";
import { clientIp, rateLimited } from "~/lib/feature-requests/http.server";
import { sanitizeDetails } from "~/lib/feature-requests/details";
import { LIMITS } from "~/lib/feature-requests/shared";
import { createComment, getProject, getRequest, isVoterKey, listAttachments, listComments, publicAttachment, publicComment, publicRequest, toggleVote, updateRequestDetails, votedRequestIds } from "~/lib/feature-requests/store.server";
import { Card, Field, Notice, Shell, StatusChip, formatDate, inputClass, primaryBtn } from "~/components/tools/feature-requests/shell";

/** Same cookie as the board page, so the vote identity carries across. */
const voterCookie = createCookie("_fr_voter", {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/tools/feature-requests",
  maxAge: 60 * 60 * 24 * 365,
});

async function voterFrom(request: Request): Promise<{ voter: string; setCookie: string | null }> {
  const existing = (await voterCookie.parse(request.headers.get("Cookie") ?? "")) as unknown;
  if (isVoterKey(existing)) return { voter: existing, setCookie: null };
  const voter = newId(24);
  return { voter, setCookie: await voterCookie.serialize(voter) };
}

export function meta({ data }: { data?: { request?: { title: string }; project?: { name: string } } }) {
  const title = data?.request?.title ?? "Feature request";
  const name = data?.project?.name ?? "Feature requests";
  return [
    { title: `${title} · ${name}` },
    { name: "description", content: `A feature request for ${name}. Read the idea and vote.` },
    { name: "robots", content: "index, follow" },
  ];
}

async function load(params: { id?: string; rid?: string }) {
  const project = await getProject(params.id ?? "").catch(() => null);
  if (!project) throw new Response("Not found", { status: 404 });
  const req = await getRequest(params.rid ?? "").catch(() => null);
  if (!req || req.projectId !== project.id || req.status === "declined") throw new Response("Not found", { status: 404 });
  return { project, req };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { project, req } = await load(params);
  const [{ token, setCookie: csrfCookie }, chrome, { voter, setCookie: vCookie }] = await Promise.all([ensureCsrfToken(request), getSiteChrome(), voterFrom(request)]);
  const voted = (await votedRequestIds(project.id, { voter })).has(req.id);
  const comments = (await listComments(req.id)).map(publicComment);
  const attachments = (await listAttachments(req.id)).map(publicAttachment);
  const data = {
    csrfToken: token,
    chrome,
    project: { id: project.id, name: project.name, boardEnabled: project.boardEnabled, accent: project.accent },
    request: publicRequest(req, voted),
    comments,
    attachments,
  };
  const headers = new Headers();
  if (csrfCookie) headers.append("Set-Cookie", csrfCookie);
  if (vCookie) headers.append("Set-Cookie", vCookie);
  return headers.has("Set-Cookie") ? Response.json(data, { headers }) : data;
}

type ActionData = { error?: string; ok?: string };

export async function action({ request, params }: ActionFunctionArgs) {
  const { project, req } = await load(params);
  const form = await request.formData();
  await validateCsrf(request, form);
  const ip = clientIp(request);
  const intent = String(form.get("intent") ?? "");
  const { voter, setCookie } = await voterFrom(request);
  const headers = new Headers();
  if (setCookie) headers.append("Set-Cookie", setCookie);
  try {
    if (intent === "vote") {
      if (!project.boardEnabled) return Response.json({ error: "Voting is off for this project." } satisfies ActionData, { status: 403, headers });
      if (rateLimited(`fr:vote:${ip}`, 60, 10 * 60_000)) return Response.json({ error: "Too many votes from this connection. Try again shortly." } satisfies ActionData, { status: 429, headers });
      await toggleVote(req.id, { voter });
      return Response.json({ ok: "vote" } satisfies ActionData, { headers });
    }
    if (intent === "edit") {
      if (rateLimited(`fr:edit:${ip}`, 20, 10 * 60_000)) return Response.json({ error: "Too many edits, try again in a minute." } satisfies ActionData, { status: 429, headers });
      await updateRequestDetails(req.id, String(form.get("email") ?? "").trim(), String(form.get("details") ?? ""));
      return Response.json({ ok: "Saved. Thanks for building the idea out." } satisfies ActionData, { headers });
    }
    if (intent === "comment") {
      if (String(form.get("website") ?? "")) return Response.json({ ok: "Comment added." } satisfies ActionData, { headers });
      if (rateLimited(`fr:comment:${ip}`, 20, 10 * 60_000)) return Response.json({ error: "Too many comments right now. Try again shortly." } satisfies ActionData, { status: 429, headers });
      await createComment(req.id, {
        body: String(form.get("body") ?? ""),
        name: String(form.get("name") ?? ""),
        email: String(form.get("email") ?? ""),
        ip,
      });
      return Response.json({ ok: "Comment added." } satisfies ActionData, { headers });
    }
    return Response.json({ error: "Unknown action." } satisfies ActionData, { status: 400, headers });
  } catch (err) {
    const e = err as AnvilError;
    return Response.json({ error: e.message || "That did not work." } satisfies ActionData, { status: e.status && e.status >= 400 ? e.status : 500, headers });
  }
}

export default function RequestPage() {
  const { chrome, csrfToken, comments, attachments, project, request: r } = useLoaderData<typeof loader>();
  const data = (useActionData() ?? {}) as ActionData;
  const busy = useNavigation().state === "submitting";
  const accent = project.accent;
  return (
    <CsrfProvider token={csrfToken}>
      <Shell chrome={chrome} backHref={`/tools/feature-requests/p/${project.id}`} backLabel={project.name} eyebrow="Feature request">
        <div className="flex gap-5">
          {project.boardEnabled ? (
            <Form method="post" className="shrink-0 pt-1">
              <CsrfInput />
              <input type="hidden" name="intent" value="vote" />
              <button
                type="submit"
                disabled={busy}
                aria-pressed={r.voted}
                aria-label={r.voted ? "Remove your vote" : "Upvote"}
                className="flex w-14 flex-col items-center rounded-xl border px-2 py-2 text-base font-semibold transition-colors"
                style={
                  r.voted
                    ? { borderColor: accent, background: `${accent}22`, color: accent }
                    : { borderColor: "rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.7)" }
                }
              >
                <ChevronUp size={18} aria-hidden="true" />
                {r.votes}
              </button>
            </Form>
          ) : null}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">{r.title}</h1>
              {r.status !== "new" ? <StatusChip status={r.status} /> : null}
            </div>
            <div className="mt-2 font-mono text-[11px] text-white/35">{formatDate(r.createdAt)}</div>
            {attachments.length > 0 ? (
              <ul className="mt-4 flex flex-wrap gap-2">
                {attachments.map((a) => (
                  <li key={a.id}>
                    <a
                      href={`/tools/feature-requests/api/attachments/${a.id}`}
                      target="_blank"
                      rel="noopener"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-white/70 hover:border-[#f5a524]/45 hover:text-white"
                    >
                      {a.name}
                      <span className="text-white/35">{Math.max(1, Math.round(a.size / 1024))}KB</span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
            {r.details ? (
              <div className="mt-5 max-w-2xl fr-rich whitespace-pre-wrap [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 text-[15px] leading-relaxed text-white/70" dangerouslySetInnerHTML={{ __html: sanitizeDetails(r.details).html }} />
            ) : (
              <p className="mt-5 text-sm text-white/40">No details yet.</p>
            )}
          </div>
        </div>

        {data.ok === "vote" ? null : data.ok ? <div className="mt-6"><Notice kind="ok">{data.ok}</Notice></div> : null}
        {data.error ? <div className="mt-6"><Notice>{data.error}</Notice></div> : null}

        <div className="mt-10">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.2em] text-white/45">
            {comments.length} comment{comments.length === 1 ? "" : "s"}
          </h2>
          <div className="mt-3 space-y-3">
            {comments.map((c) => (
              <div key={c.id} className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                <div className="font-mono text-[11px] text-white/40">
                  {c.name}
                  {" · "}
                  {formatDate(c.createdAt)}
                </div>
                <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-white/70">{c.body}</p>
              </div>
            ))}
          </div>
          <Card className="mt-4">
            <Form method="post" className="space-y-4">
              <CsrfInput />
              <input type="hidden" name="intent" value="comment" />
              <div className="absolute -left-[9999px] top-0" aria-hidden="true">
                <label htmlFor="c-website">Website</label>
                <input id="c-website" name="website" tabIndex={-1} autoComplete="off" />
              </div>
              <Field label="Comment" htmlFor="c-body">
                <textarea id="c-body" name="body" rows={3} required maxLength={LIMITS.commentBody} placeholder="Add to the conversation." className={inputClass} />
              </Field>
              <Field label="Name (optional)" htmlFor="c-name">
                <input id="c-name" name="name" maxLength={LIMITS.commentName} className={inputClass} />
              </Field>
              <Field label="Email" htmlFor="c-email" hint="Never shown publicly; it ties the comment to you.">
                <input id="c-email" name="email" type="email" required maxLength={LIMITS.email} className={inputClass} />
              </Field>
              <button
                type="submit"
                disabled={busy}
                className={primaryBtn}
                style={{ background: accent, boxShadow: `0 8px 30px -10px ${accent}99`, color: "#111" }}
              >
                Comment
              </button>
            </Form>
          </Card>
        </div>

        <Card className="mt-10">
          <h2 className="text-base font-semibold text-white">Wrote this? Build it out.</h2>
          <p className="mt-1.5 text-sm text-white/50">
            Enter the email you submitted the request with and you can rewrite the details, with room to think.
          </p>
          <Form method="post" className="mt-4 space-y-4">
            <CsrfInput />
            <input type="hidden" name="intent" value="edit" />
            <Field label="Your email" htmlFor="email">
              <input id="email" name="email" type="email" required maxLength={LIMITS.email} className={inputClass} />
            </Field>
            <Field label="Details" htmlFor="details">
              <textarea id="details" name="details" rows={10} maxLength={LIMITS.details} defaultValue={r.details} className={inputClass} />
            </Field>
            <button
              type="submit"
              disabled={busy}
              className={primaryBtn}
              style={{ background: accent, boxShadow: `0 8px 30px -10px ${accent}99`, color: "#111" }}
            >
              Save details
            </button>
          </Form>
        </Card>
      </Shell>
    </CsrfProvider>
  );
}
