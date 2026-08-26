/**
 * /project: the self-serve home for project owners. Sign in with an emailed
 * code (Anvil OTP); once signed in, every fr_projects entry whose ownerEmail
 * matches the address (or whose ownerId matches the account) is listed.
 * Email is the durable ownership claim: it survives Anvil account moves.
 */

import { Form, redirect, useActionData, useLoaderData, useNavigation, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { ArrowRight, KeyRound } from "lucide-react";
import { getSiteChrome } from "~/lib/site-chrome.server";
import { ensureCsrfToken, validateCsrf } from "~/lib/csrf.server";
import { CsrfInput, CsrfProvider } from "~/components/csrf-input";
import { AnvilError, anvilOtpRequest, anvilOtpVerify, identityFromToken } from "~/lib/feature-requests/anvil.server";
import { frSignInHeaders, frSignOutHeaders, getFrUser } from "~/lib/feature-requests/session.server";
import { listManagedProjects, type Project } from "~/lib/feature-requests/store.server";
import { clientIp, rateLimited } from "~/lib/feature-requests/http.server";
import { Card, Field, Notice, Shell, TOOL_PATH, formatDate, ghostBtn, inputClass, molten, primaryBtn, primaryBtnStyle } from "~/components/tools/feature-requests/shell";

export function meta() {
  return [
    { title: "Your project · Devforge" },
    { name: "description", content: "Manage your feature requests project: sign in with an emailed code." },
    { name: "robots", content: "noindex" },
  ];
}

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await getFrUser(request);
  const [{ token, setCookie }, chrome] = await Promise.all([ensureCsrfToken(request), getSiteChrome()]);
  let projects: Project[] = [];
  if (user) projects = await listManagedProjects({ id: user.id, email: user.email }).catch(() => []);
  const data = { csrfToken: token, chrome, user: user ? { email: user.email } : null, projects };
  return setCookie ? Response.json(data, { headers: { "Set-Cookie": setCookie } }) : data;
}

type ActionData = { error?: string; stage?: "code"; email?: string; notice?: string };

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  await validateCsrf(request, form);
  const intent = String(form.get("intent") ?? "");
  if (intent === "sign-out") {
    return redirect("/project", { headers: await frSignOutHeaders() });
  }
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const ip = clientIp(request);
  if (rateLimited(`fr:project-signin:${ip}`, 12, 10 * 60_000)) {
    return Response.json({ error: "Too many attempts. Try again in a few minutes." } satisfies ActionData, { status: 429 });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: "Enter the email address your project is registered under." } satisfies ActionData, { status: 400 });
  }
  try {
    if (intent === "otp-request") {
      await anvilOtpRequest(email);
      return { stage: "code", email, notice: "If that address has an account, a sign-in code is on its way." } satisfies ActionData;
    }
    if (intent === "otp-verify") {
      const code = String(form.get("code") ?? "").trim();
      if (!code) return Response.json({ error: "Enter the code from the email.", stage: "code", email } satisfies ActionData, { status: 400 });
      const tokens = await anvilOtpVerify(email, code);
      const identity = identityFromToken(tokens.accessToken);
      if (!identity) throw new AnvilError("Anvil returned an unreadable token", 502);
      return redirect("/project", { headers: await frSignInHeaders(identity, tokens) });
    }
    return Response.json({ error: "Unknown action." } satisfies ActionData, { status: 400 });
  } catch (err) {
    const e = err as AnvilError;
    const status = typeof e.status === "number" ? e.status : 500;
    let message = "Sign-in failed. Please try again.";
    if (status === 401 || status === 403) message = "That code is not valid or has expired. Request a new one.";
    else if (status === 503) message = "Email sign-in is not available right now. Please try again shortly.";
    else if (status === 429) message = "Too many attempts. Try again in a few minutes.";
    const body: ActionData = { error: message, email };
    if (intent === "otp-verify") body.stage = "code";
    return Response.json(body, { status: status >= 400 && status < 600 ? status : 500 });
  }
}

export default function ProjectHome() {
  const { chrome, csrfToken, user, projects } = useLoaderData<typeof loader>();
  const data = (useActionData() ?? {}) as ActionData;
  const busy = useNavigation().state === "submitting";
  const codeStage = data.stage === "code";

  return (
    <CsrfProvider token={csrfToken}>
      <Shell
        chrome={chrome}
        backHref={TOOL_PATH}
        backLabel="Feature requests"
        eyebrow="Your project"
        wide={Boolean(user)}
        nav={
          user ? (
            <Form method="post" className="flex items-center gap-3 text-xs text-white/45">
              <CsrfInput />
              <input type="hidden" name="intent" value="sign-out" />
              <span className="font-mono">{user.email}</span>
              <button type="submit" className="rounded-full border border-white/10 px-3 py-1 transition-colors hover:bg-white/[0.06] hover:text-white">
                Sign out
              </button>
            </Form>
          ) : undefined
        }
      >
        {user ? (
          <>
            <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Your projects</h1>
            <p className="mt-3 max-w-2xl text-white/55">
              Everything registered to <span className="font-mono text-white/75">{user.email}</span>.
            </p>
            <div className="mt-8 space-y-3">
              {projects.length === 0 ? (
                <Card>
                  <p className="text-sm text-white/55">
                    No project is registered to this address yet. If someone set one up for you, ask them to put this email in the
                    project's owner field; if you want to start one yourself, head to{" "}
                    <a href={`${TOOL_PATH}/projects`} className="text-[#ffd98a] underline-offset-2 hover:underline">
                      the feature requests tool
                    </a>
                    .
                  </p>
                </Card>
              ) : (
                projects.map((p) => (
                  <a
                    key={p.id}
                    href={`/project/${p.id}`}
                    className="group flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.02] px-5 py-4 transition-colors hover:border-[#f5a524]/40 hover:bg-white/[0.04]"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-base font-semibold text-white">{p.name}</div>
                      <div className="mt-1 font-mono text-[11px] text-white/40">
                        {p.id} · created {formatDate(p.createdAt)}
                      </div>
                    </div>
                    <ArrowRight size={16} className="shrink-0 text-white/30 transition-colors group-hover:text-[#f5a524]" aria-hidden="true" />
                  </a>
                ))
              )}
            </div>
          </>
        ) : (
          <>
            <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Manage {molten("your project")}.</h1>
            <p className="mt-3 max-w-xl text-white/55">
              Sign in with the email address your project is registered under. We send a one-time code; no password needed.
            </p>
            <Card className="mt-8 max-w-md">
              <div className="flex items-center gap-2 text-base font-semibold text-white">
                <KeyRound size={16} className="text-[#f5a524]" aria-hidden="true" />
                Email sign-in
              </div>
              {codeStage ? (
                <Form method="post" className="mt-4 space-y-4">
                  <CsrfInput />
                  <input type="hidden" name="intent" value="otp-verify" />
                  <input type="hidden" name="email" value={data.email ?? ""} />
                  {data.notice ? <Notice kind="info">{data.notice}</Notice> : null}
                  <Field label={`Code sent to ${data.email ?? "your email"}`} htmlFor="code">
                    <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" required className={inputClass} />
                  </Field>
                  {data.error ? <Notice>{data.error}</Notice> : null}
                  <div className="flex flex-wrap gap-3">
                    <button type="submit" disabled={busy} className={primaryBtn} style={primaryBtnStyle}>
                      Verify and sign in
                    </button>
                    <a href="/project" className={ghostBtn}>
                      Start over
                    </a>
                  </div>
                </Form>
              ) : (
                <Form method="post" className="mt-4 space-y-4">
                  <CsrfInput />
                  <input type="hidden" name="intent" value="otp-request" />
                  <Field label="Email" htmlFor="email">
                    <input id="email" name="email" type="email" autoComplete="email" required defaultValue={data.email ?? ""} className={inputClass} />
                  </Field>
                  {data.error ? <Notice>{data.error}</Notice> : null}
                  <button type="submit" disabled={busy} className={primaryBtn} style={primaryBtnStyle}>
                    Email me a code
                  </button>
                </Form>
              )}
            </Card>
          </>
        )}
      </Shell>
    </CsrfProvider>
  );
}
