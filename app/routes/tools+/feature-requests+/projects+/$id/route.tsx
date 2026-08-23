/**
 * /tools/feature-requests/projects/:id: a project's dashboard. Requests with
 * status triage, the embed snippets, the public board link and settings.
 */

import { Form, redirect, useActionData, useLoaderData, useNavigation, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { ExternalLink, Trash2 } from "lucide-react";
import { getSiteChrome } from "~/lib/site-chrome.server";
import { ensureCsrfToken, validateCsrf } from "~/lib/csrf.server";
import { CsrfInput, CsrfProvider } from "~/components/csrf-input";
import { AnvilError } from "~/lib/feature-requests/anvil.server";
import { requireFrUser } from "~/lib/feature-requests/session.server";
import {
  LIMITS,
  STATUSES,
  STATUS_LABEL,
  deleteProject,
  deleteRequest,
  getOwnedProject,
  isStatus,
  listRequests,
  parseOriginList,
  setRequestStatus,
  updateProject,
  type RequestStatus,
} from "~/lib/feature-requests/store.server";
import { Card, Field, Notice, Shell, StatusChip, TOOL_PATH, dangerBtn, formatDate, ghostBtn, inputClass, labelClass, primaryBtn, primaryBtnStyle } from "~/components/tools/feature-requests/shell";

export function meta({ data }: { data?: { project?: { name: string } } }) {
  return [{ title: `${data?.project?.name ?? "Project"} · Feature requests · Devforge` }, { name: "robots", content: "noindex" }];
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const user = await requireFrUser(request);
  const id = params.id ?? "";
  const project = await getOwnedProject(id, user.id).catch(() => null);
  if (!project) throw new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  const filter = url.searchParams.get("status") ?? "all";
  const sort = url.searchParams.get("sort") === "newest" ? "newest" : "top";
  const [{ token, setCookie }, chrome, all] = await Promise.all([
    ensureCsrfToken(request),
    getSiteChrome(),
    listRequests(project.id, { includeDeclined: true, sort }),
  ]);
  const counts: Record<string, number> = { all: all.length };
  for (const s of STATUSES) counts[s] = all.filter((r) => r.status === s).length;
  const requests = filter === "all" ? all : all.filter((r) => r.status === filter);
  const origin = (process.env.PUBLIC_ORIGIN || url.origin).replace(/\/+$/, "");
  const data = { csrfToken: token, chrome, user: { email: user.email }, project, requests, counts, filter, sort, origin };
  return setCookie ? Response.json(data, { headers: { "Set-Cookie": setCookie } }) : data;
}

export async function action({ request, params }: ActionFunctionArgs) {
  const user = await requireFrUser(request);
  const form = await request.formData();
  await validateCsrf(request, form);
  const id = params.id ?? "";
  const project = await getOwnedProject(id, user.id).catch(() => null);
  if (!project) throw new Response("Not found", { status: 404 });
  const intent = String(form.get("intent") ?? "");
  try {
    if (intent === "status") {
      const status = String(form.get("status") ?? "");
      if (!isStatus(status)) return Response.json({ error: "Unknown status." }, { status: 400 });
      await setRequestStatus(project.id, String(form.get("requestId") ?? ""), status as RequestStatus);
      return { ok: true };
    }
    if (intent === "delete-request") {
      await deleteRequest(project.id, String(form.get("requestId") ?? ""));
      return { ok: true };
    }
    if (intent === "settings") {
      await updateProject(project.id, user.id, {
        name: String(form.get("name") ?? project.name),
        intro: String(form.get("intro") ?? ""),
        origins: parseOriginList(String(form.get("origins") ?? "")),
        boardEnabled: form.get("boardEnabled") === "on",
        accent: String(form.get("accent") ?? ""),
        buttonLabel: String(form.get("buttonLabel") ?? ""),
      });
      return { ok: true, saved: true };
    }
    if (intent === "delete-project") {
      if (String(form.get("confirm") ?? "").trim() !== project.name) {
        return Response.json({ error: "Type the project name exactly to confirm deletion." }, { status: 400 });
      }
      await deleteProject(project.id, user.id);
      return redirect(`${TOOL_PATH}/projects`);
    }
    return Response.json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    const e = err as AnvilError;
    return Response.json({ error: e.message || "That did not work." }, { status: e.status && e.status >= 400 ? e.status : 500 });
  }
}

export default function ProjectDashboard() {
  const { chrome, csrfToken, user, project, requests, counts, filter, sort, origin } = useLoaderData<typeof loader>();
  const data = (useActionData() ?? {}) as { error?: string; saved?: boolean };
  const busy = useNavigation().state === "submitting";
  const base = `${TOOL_PATH}/projects/${project.id}`;
  const embedSrc = `${origin}${TOOL_PATH}/embed.js`;
  const floating = `<script src="${embedSrc}" data-project="${project.id}" async></script>`;
  const inline = `<div id="feature-requests"></div>\n<script src="${embedSrc}" data-project="${project.id}" data-mode="inline" data-target="#feature-requests" async></script>`;
  const boardUrl = `${origin}${TOOL_PATH}/p/${project.id}`;
  const tabs: { key: string; label: string }[] = [{ key: "all", label: "All" }, ...STATUSES.map((s) => ({ key: s, label: STATUS_LABEL[s] }))];

  return (
    <CsrfProvider token={csrfToken}>
      <Shell
        chrome={chrome}
        backHref={`${TOOL_PATH}/projects`}
        backLabel="Your projects"
        eyebrow={`Feature requests · ${project.id}`}
        wide
        nav={
          <Form method="post" action={`${TOOL_PATH}/sign-out`} className="flex items-center gap-3 text-xs text-white/45">
            <CsrfInput />
            <span className="font-mono">{user.email}</span>
            <button type="submit" className="rounded-full border border-white/10 px-3 py-1 transition-colors hover:bg-white/[0.06] hover:text-white">
              Sign out
            </button>
          </Form>
        }
      >
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">{project.name}</h1>
            <p className="mt-2 text-sm text-white/50">
              {counts.all} request{counts.all === 1 ? "" : "s"} · {counts.new} new · {counts.planned} planned · {counts.in_progress} in progress · {counts.done} done
            </p>
          </div>
          <a href={boardUrl} target="_blank" rel="noreferrer" className={ghostBtn}>
            Public board <ExternalLink size={14} aria-hidden="true" />
          </a>
        </div>

        {data.error ? <div className="mt-4"><Notice>{data.error}</Notice></div> : null}
        {data.saved ? <div className="mt-4"><Notice kind="ok">Settings saved.</Notice></div> : null}

        <div className="mt-8 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          {/* Requests */}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-1.5">
                {tabs.map((t) => (
                  <a
                    key={t.key}
                    href={`${base}?status=${t.key}&sort=${sort}`}
                    className={`rounded-full border px-3 py-1 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors ${
                      filter === t.key ? "border-[#f5a524]/50 bg-[#f5a524]/10 text-[#ffd98a]" : "border-white/10 text-white/45 hover:text-white"
                    }`}
                  >
                    {t.label} <span className="text-white/35">{counts[t.key] ?? 0}</span>
                  </a>
                ))}
              </div>
              <div className="flex gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em]">
                {(["top", "newest"] as const).map((s) => (
                  <a key={s} href={`${base}?status=${filter}&sort=${s}`} className={`rounded-full px-2.5 py-1 ${sort === s ? "text-[#ffd98a]" : "text-white/40 hover:text-white"}`}>
                    {s === "top" ? "Top voted" : "Newest"}
                  </a>
                ))}
              </div>
            </div>

            <div className="mt-4 space-y-3">
              {requests.length === 0 ? (
                <Card>
                  <p className="text-sm text-white/55">
                    {counts.all === 0 ? "Nothing yet. Add the snippet to your site and requests will show up here." : "No requests with this status."}
                  </p>
                </Card>
              ) : (
                requests.map((r) => (
                  <div key={r.id} className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 sm:p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-base font-semibold text-white">{r.title}</h3>
                          <StatusChip status={r.status} />
                        </div>
                        {r.details ? <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-white/60">{r.details}</p> : null}
                        <div className="mt-2 font-mono text-[11px] text-white/35">
                          {r.votes} vote{r.votes === 1 ? "" : "s"} · {formatDate(r.createdAt)}
                          {r.email ? ` · ${r.email}` : ""}
                          {r.origin ? ` · from ${r.origin}` : ""}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Form method="post" className="flex items-center gap-2">
                          <CsrfInput />
                          <input type="hidden" name="intent" value="status" />
                          <input type="hidden" name="requestId" value={r.id} />
                          <label className="sr-only" htmlFor={`status-${r.id}`}>Status</label>
                          <select
                            id={`status-${r.id}`}
                            name="status"
                            defaultValue={r.status}
                            className="rounded-full border border-white/10 bg-[#0d0a17] px-3 py-1.5 text-xs text-white outline-none focus:border-[#f5a524]/50"
                          >
                            {STATUSES.map((s) => (
                              <option key={s} value={s}>
                                {STATUS_LABEL[s]}
                              </option>
                            ))}
                          </select>
                          <button type="submit" disabled={busy} className={ghostBtn + " px-3 py-1.5 text-xs"}>
                            Set
                          </button>
                        </Form>
                        <Form method="post">
                          <CsrfInput />
                          <input type="hidden" name="intent" value="delete-request" />
                          <input type="hidden" name="requestId" value={r.id} />
                          <button type="submit" disabled={busy} className="rounded-full border border-white/10 p-2 text-white/40 transition-colors hover:border-red-400/40 hover:text-red-200" aria-label="Delete request" title="Delete request">
                            <Trash2 size={14} aria-hidden="true" />
                          </button>
                        </Form>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Embed + settings */}
          <div className="min-w-0 space-y-6">
            <Card>
              <h2 className="text-base font-semibold text-white">Add it to your site</h2>
              <p className="mt-1 text-sm text-white/50">Floating button with a panel (board + form):</p>
              <pre className="mt-2 whitespace-pre-wrap break-all rounded-xl border border-white/10 bg-black/40 p-3 font-mono text-[12px] leading-relaxed text-white/80">{floating}</pre>
              <p className="mt-4 text-sm text-white/50">Inline board and form inside an element you choose:</p>
              <pre className="mt-2 whitespace-pre-wrap break-all rounded-xl border border-white/10 bg-black/40 p-3 font-mono text-[12px] leading-relaxed text-white/80">{inline}</pre>
              <p className="mt-3 text-xs text-white/40">
                Optional attributes: <code className="font-mono text-white/60">data-label</code>, <code className="font-mono text-white/60">data-color</code>,{" "}
                <code className="font-mono text-white/60">data-position="left"</code>, <code className="font-mono text-white/60">data-theme="light"</code>.
                The hosted board also works on its own:{" "}
                <a href={boardUrl} className="text-[#ffd98a] underline-offset-2 hover:underline break-all">
                  {boardUrl}
                </a>
              </p>
            </Card>

            <Card>
              <h2 className="text-base font-semibold text-white">Settings</h2>
              <Form method="post" className="mt-4 space-y-4">
                <CsrfInput />
                <input type="hidden" name="intent" value="settings" />
                <Field label="Name" htmlFor="name">
                  <input id="name" name="name" required maxLength={LIMITS.projectName} defaultValue={project.name} className={inputClass} />
                </Field>
                <Field label="Intro" htmlFor="intro" hint="Shown at the top of the board.">
                  <input id="intro" name="intro" maxLength={LIMITS.intro} defaultValue={project.intro} className={inputClass} />
                </Field>
                <Field label="Allowed origins" htmlFor="origins" hint="One per line. Empty accepts submissions and votes from any site.">
                  <textarea id="origins" name="origins" rows={3} defaultValue={project.origins.join("\n")} className={inputClass} />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Button label" htmlFor="buttonLabel">
                    <input id="buttonLabel" name="buttonLabel" maxLength={LIMITS.buttonLabel} defaultValue={project.buttonLabel} className={inputClass} />
                  </Field>
                  <Field label="Accent colour" htmlFor="accent">
                    <input id="accent" name="accent" type="color" defaultValue={project.accent} className="h-10 w-full cursor-pointer rounded-xl border border-white/10 bg-white/[0.03] p-1" />
                  </Field>
                </div>
                <label className="flex items-center gap-2 text-sm text-white/70">
                  <input type="checkbox" name="boardEnabled" defaultChecked={project.boardEnabled} className="h-4 w-4 accent-[#f5a524]" />
                  Public board and upvotes (off = private inbox, the widget only shows the form)
                </label>
                <button type="submit" disabled={busy} className={primaryBtn} style={primaryBtnStyle}>
                  Save settings
                </button>
              </Form>
            </Card>

            <Card>
              <h2 className="text-base font-semibold text-white">Delete project</h2>
              <p className="mt-1 text-sm text-white/50">Removes the project, all its requests and votes. There is no undo.</p>
              <Form method="post" className="mt-3 flex flex-wrap items-end gap-3">
                <CsrfInput />
                <input type="hidden" name="intent" value="delete-project" />
                <div className="flex-1">
                  <label htmlFor="confirm" className={labelClass}>
                    Type the project name to confirm
                  </label>
                  <input id="confirm" name="confirm" placeholder={project.name} className={inputClass} />
                </div>
                <button type="submit" disabled={busy} className={dangerBtn}>
                  Delete
                </button>
              </Form>
            </Card>
          </div>
        </div>
      </Shell>
    </CsrfProvider>
  );
}
