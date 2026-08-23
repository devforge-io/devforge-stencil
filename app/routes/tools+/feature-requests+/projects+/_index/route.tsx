/**
 * /tools/feature-requests/projects: the signed-in person's projects, and the
 * form that creates a new one.
 */

import { Form, redirect, useActionData, useLoaderData, useNavigation, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { ArrowRight, Plus } from "lucide-react";
import { getSiteChrome } from "~/lib/site-chrome.server";
import { ensureCsrfToken, validateCsrf } from "~/lib/csrf.server";
import { CsrfInput, CsrfProvider } from "~/components/csrf-input";
import { AnvilError } from "~/lib/feature-requests/anvil.server";
import { requireFrUser } from "~/lib/feature-requests/session.server";
import { LIMITS, createProject, listProjects, parseOriginList } from "~/lib/feature-requests/store.server";
import { Card, Field, Notice, Shell, TOOL_PATH, formatDate, ghostBtn, inputClass, primaryBtn, primaryBtnStyle } from "~/components/tools/feature-requests/shell";

export function meta() {
  return [{ title: "Your projects · Feature requests · Devforge" }, { name: "robots", content: "noindex" }];
}

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireFrUser(request);
  const [{ token, setCookie }, chrome, projects] = await Promise.all([ensureCsrfToken(request), getSiteChrome(), listProjects(user.id)]);
  const data = { csrfToken: token, chrome, user: { email: user.email }, projects };
  return setCookie ? Response.json(data, { headers: { "Set-Cookie": setCookie } }) : data;
}

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireFrUser(request);
  const form = await request.formData();
  await validateCsrf(request, form);
  const name = String(form.get("name") ?? "").trim();
  if (name.length < 2) return Response.json({ error: "Give the project a name." }, { status: 400 });
  try {
    const project = await createProject(
      { id: user.id, email: user.email },
      { name, intro: String(form.get("intro") ?? ""), origins: parseOriginList(String(form.get("origins") ?? "")) },
    );
    return redirect(`${TOOL_PATH}/projects/${project.id}`);
  } catch (err) {
    const e = err as AnvilError;
    return Response.json({ error: e.message || "Could not create the project." }, { status: e.status && e.status >= 400 ? e.status : 500 });
  }
}

export default function Projects() {
  const { chrome, csrfToken, user, projects } = useLoaderData<typeof loader>();
  const data = (useActionData() ?? {}) as { error?: string };
  const busy = useNavigation().state === "submitting";
  return (
    <CsrfProvider token={csrfToken}>
      <Shell
        chrome={chrome}
        backHref={TOOL_PATH}
        backLabel="Feature requests"
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
        <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Your projects</h1>
        <p className="mt-3 max-w-2xl text-white/55">
          One project per site or product. Each gets its own embed snippet, public board and dashboard.
        </p>

        <div className="mt-8 grid gap-6 lg:grid-cols-[1.2fr_1fr]">
          <div className="space-y-3">
            {projects.length === 0 ? (
              <Card>
                <p className="text-sm text-white/55">No projects yet. Create your first one on the right; it takes ten seconds.</p>
              </Card>
            ) : (
              projects.map((p) => (
                <a
                  key={p.id}
                  href={`${TOOL_PATH}/projects/${p.id}`}
                  className="group flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.02] px-5 py-4 transition-colors hover:border-[#f5a524]/40 hover:bg-white/[0.04]"
                >
                  <div className="min-w-0">
                    <div className="truncate text-base font-semibold text-white">{p.name}</div>
                    <div className="mt-1 font-mono text-[11px] text-white/40">
                      {p.id} · created {formatDate(p.createdAt)}
                      {p.origins.length ? ` · ${p.origins.length} allowed origin${p.origins.length === 1 ? "" : "s"}` : " · any origin"}
                    </div>
                  </div>
                  <ArrowRight size={16} className="shrink-0 text-white/30 transition-colors group-hover:text-[#f5a524]" aria-hidden="true" />
                </a>
              ))
            )}
          </div>

          <Card>
            <div className="flex items-center gap-2 text-base font-semibold text-white">
              <Plus size={16} className="text-[#f5a524]" aria-hidden="true" />
              New project
            </div>
            <Form method="post" className="mt-4 space-y-4">
              <CsrfInput />
              <Field label="Name" htmlFor="name">
                <input id="name" name="name" required maxLength={LIMITS.projectName} placeholder="Acme app" className={inputClass} />
              </Field>
              <Field label="Intro (optional)" htmlFor="intro" hint="Shown at the top of the board.">
                <input id="intro" name="intro" maxLength={LIMITS.intro} placeholder="Tell us what would make Acme better for you." className={inputClass} />
              </Field>
              <Field label="Allowed origins (optional)" htmlFor="origins" hint="One per line. Leave empty to accept requests from anywhere. You can change this later.">
                <textarea id="origins" name="origins" rows={3} placeholder={"https://acme.example\nhttps://app.acme.example"} className={inputClass} />
              </Field>
              {data.error ? <Notice>{data.error}</Notice> : null}
              <div className="flex gap-3">
                <button type="submit" disabled={busy} className={primaryBtn} style={primaryBtnStyle}>
                  Create project
                </button>
                <a href={TOOL_PATH} className={ghostBtn}>
                  About the tool
                </a>
              </div>
            </Form>
          </Card>
        </div>
      </Shell>
    </CsrfProvider>
  );
}
