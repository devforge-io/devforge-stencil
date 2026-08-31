/**
 * /tools/feature-requests/p/:id: a project's hosted public board. Works
 * without JavaScript (plain forms), with the same rate limits and origin
 * rules as the JSON API the widget uses.
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
import { createRequest, getProject, isVoterKey, listRequests, publicRequest, toggleVote, votedRequestIds } from "~/lib/feature-requests/store.server";
import { Card, Field, Notice, Shell, StatusChip, TOOL_PATH, formatDate, inputClass, primaryBtn } from "~/components/tools/feature-requests/shell";

/** Anonymous voter identity for the hosted board (the widget keeps its own in localStorage). */
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

export function meta({ data }: { data?: { project?: { name: string; intro: string } } }) {
  const name = data?.project?.name ?? "Feature requests";
  return [
    { title: `${name} · Feature requests` },
    { name: "description", content: data?.project?.intro || `Suggest and vote on features for ${name}.` },
    { name: "robots", content: "index, follow" },
  ];
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const project = await getProject(params.id ?? "").catch(() => null);
  if (!project) throw new Response("Not found", { status: 404 });
  const [{ token, setCookie: csrfCookie }, chrome, { voter, setCookie: vCookie }] = await Promise.all([ensureCsrfToken(request), getSiteChrome(), voterFrom(request)]);
  const [requests, voted] = project.boardEnabled
    ? await Promise.all([listRequests(project.id), votedRequestIds(project.id, { voter })])
    : [[], new Set<string>()];
  const data = {
    csrfToken: token,
    chrome,
    project: { id: project.id, name: project.name, intro: project.intro, boardEnabled: project.boardEnabled, accent: project.accent },
    requests: requests.map((r) => publicRequest(r, voted.has(r.id))),
  };
  const headers = new Headers();
  if (csrfCookie) headers.append("Set-Cookie", csrfCookie);
  if (vCookie) headers.append("Set-Cookie", vCookie);
  return headers.has("Set-Cookie") ? Response.json(data, { headers }) : data;
}

type ActionData = { error?: string; ok?: string };

export async function action({ request, params }: ActionFunctionArgs) {
  const project = await getProject(params.id ?? "").catch(() => null);
  if (!project) throw new Response("Not found", { status: 404 });
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
      await toggleVote(String(form.get("requestId") ?? ""), { voter });
      return Response.json({ ok: "vote" } satisfies ActionData, { headers });
    }
    if (intent === "submit") {
      if (String(form.get("website") ?? "")) return Response.json({ ok: "Thanks, your request is in." } satisfies ActionData, { headers });
      if (rateLimited(`fr:submit:${ip}`, 10, 10 * 60_000) || rateLimited(`fr:submit:project:${project.id}`, 120, 60 * 60_000)) {
        return Response.json({ error: "Too many requests right now. Try again in a few minutes." } satisfies ActionData, { status: 429, headers });
      }
      const created = await createRequest(project.id, {
        title: String(form.get("title") ?? ""),
        details: String(form.get("details") ?? ""),
        email: String(form.get("email") ?? ""),
        origin: "hosted-board",
        ip,
      });
      if (project.boardEnabled) await toggleVote(created.id, { email: String(form.get("email") ?? "").trim() || undefined, voter }).catch(() => null);
      return Response.json({ ok: "Thanks, your request is in." } satisfies ActionData, { headers });
    }
    return Response.json({ error: "Unknown action." } satisfies ActionData, { status: 400, headers });
  } catch (err) {
    const e = err as AnvilError;
    return Response.json({ error: e.message || "That did not work." } satisfies ActionData, { status: e.status && e.status >= 400 ? e.status : 500, headers });
  }
}

export default function PublicBoard() {
  const { chrome, csrfToken, project, requests } = useLoaderData<typeof loader>();
  const data = (useActionData() ?? {}) as ActionData;
  const busy = useNavigation().state === "submitting";
  const accent = project.accent;
  return (
    <CsrfProvider token={csrfToken}>
      <Shell chrome={chrome} backHref={TOOL_PATH} backLabel="Feature requests by Devforge" eyebrow="Feature requests">
        <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">{project.name}</h1>
        {project.intro ? <p className="mt-3 max-w-2xl text-white/60">{project.intro}</p> : null}

        <Card className="mt-8">
          <h2 className="text-base font-semibold text-white">Suggest a feature</h2>
          <Form method="post" className="mt-4 space-y-4">
            <CsrfInput />
            <input type="hidden" name="intent" value="submit" />
            <div className="absolute -left-[9999px] top-0" aria-hidden="true">
              <label htmlFor="website">Website</label>
              <input id="website" name="website" tabIndex={-1} autoComplete="off" />
            </div>
            <Field label="Title" htmlFor="title">
              <input id="title" name="title" required minLength={3} maxLength={LIMITS.title} placeholder="What would you like?" className={inputClass} />
            </Field>
            <Field label="Details (optional)" htmlFor="details">
              <textarea id="details" name="details" rows={3} maxLength={LIMITS.details} placeholder="Why it matters, how you would use it." className={inputClass} />
            </Field>
            <Field label="Email (optional)" htmlFor="email" hint="Only so the team can follow up. Never shown publicly.">
              <input id="email" name="email" type="email" maxLength={LIMITS.email} className={inputClass} />
            </Field>
            {data.error && !data.ok ? <Notice>{data.error}</Notice> : null}
            {data.ok && data.ok !== "vote" ? <Notice kind="ok">{data.ok}</Notice> : null}
            <button
              type="submit"
              disabled={busy}
              className={primaryBtn}
              style={{ background: accent, boxShadow: `0 8px 30px -10px ${accent}99`, color: "#111" }}
            >
              Send request
            </button>
          </Form>
        </Card>

        {project.boardEnabled ? (
          <div className="mt-8">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.2em] text-white/45">
              {requests.length} request{requests.length === 1 ? "" : "s"}
            </h2>
            <div className="mt-3 space-y-3">
              {requests.length === 0 ? (
                <p className="text-sm text-white/50">Nothing here yet. Be the first.</p>
              ) : (
                requests.map((r) => (
                  <div key={r.id} className="flex gap-4 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                    <Form method="post" className="shrink-0">
                      <CsrfInput />
                      <input type="hidden" name="intent" value="vote" />
                      <input type="hidden" name="requestId" value={r.id} />
                      <button
                        type="submit"
                        disabled={busy}
                        aria-pressed={r.voted}
                        aria-label={r.voted ? "Remove your vote" : "Upvote"}
                        className="flex w-12 flex-col items-center rounded-xl border px-2 py-1.5 text-sm font-semibold transition-colors"
                        style={
                          r.voted
                            ? { borderColor: accent, background: `${accent}22`, color: accent }
                            : { borderColor: "rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.7)" }
                        }
                      >
                        <ChevronUp size={16} aria-hidden="true" />
                        {r.votes}
                      </button>
                    </Form>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-semibold text-white">
                          <a href={`/tools/feature-requests/p/${project.id}/r/${r.id}`} className="transition-colors hover:text-[#f5a524]">
                            {r.title}
                          </a>
                        </h3>
                        {r.status !== "new" ? <StatusChip status={r.status} /> : null}
                      </div>
                      {r.details ? <div className="mt-1.5 fr-rich whitespace-pre-wrap [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 text-sm leading-relaxed text-white/60" dangerouslySetInnerHTML={{ __html: sanitizeDetails(r.details).html }} /> : null}
                      <div className="mt-1.5 font-mono text-[11px] text-white/35">{formatDate(r.createdAt)}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : null}
      </Shell>
    </CsrfProvider>
  );
}
