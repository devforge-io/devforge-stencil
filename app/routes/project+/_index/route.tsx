/**
 * /project: the self-serve home for project owners. Sign-in is the site-wide
 * Devforge account (/account/sign-in: password or emailed code, which also
 * creates the account for an owner who never had one); once signed in, every
 * fr_projects entry whose ownerId matches the account is listed. Email is the
 * durable ownership claim: it survives Anvil account moves.
 */

import { Form, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { ArrowRight } from "lucide-react";
import { getSiteChrome } from "~/lib/site-chrome.server";
import { ensureCsrfToken } from "~/lib/csrf.server";
import { CsrfInput, CsrfProvider } from "~/components/csrf-input";
import { getAccountUser } from "~/lib/account/session.server";
import { SIGN_OUT_PATH, signInHref, signUpHref } from "~/lib/account/paths";
import { listManagedProjects, type Project } from "~/lib/feature-requests/store.server";
import { Card, Shell, TOOL_PATH, formatDate, ghostBtn, molten, primaryBtn, primaryBtnStyle } from "~/components/tools/feature-requests/shell";

const HERE = "/project";

export function meta() {
  return [
    { title: "Your project · Devforge" },
    { name: "description", content: "Manage your feature requests project with your Devforge account." },
    { name: "robots", content: "noindex" },
  ];
}

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await getAccountUser(request);
  const [{ token, setCookie }, chrome] = await Promise.all([ensureCsrfToken(request), getSiteChrome()]);
  let projects: Project[] = [];
  if (user) projects = await listManagedProjects({ id: user.id }).catch(() => []);
  const data = { csrfToken: token, chrome, user: user ? { email: user.email } : null, projects };
  return setCookie ? Response.json(data, { headers: { "Set-Cookie": setCookie } }) : data;
}

export default function ProjectHome() {
  const { chrome, csrfToken, user, projects } = useLoaderData<typeof loader>();

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
            <Form method="post" action={SIGN_OUT_PATH} className="flex items-center gap-3 text-xs text-white/45">
              <CsrfInput />
              <input type="hidden" name="next" value={HERE} />
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
              Sign in with your Devforge account using the email address your project is registered under. Never set a password?
              The emailed code signs you in and creates the account on the spot.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a href={signInHref(HERE)} className={primaryBtn} style={primaryBtnStyle}>
                Sign in
              </a>
              <a href={signUpHref(HERE)} className={ghostBtn}>
                Create an account
              </a>
            </div>
          </>
        )}
      </Shell>
    </CsrfProvider>
  );
}
