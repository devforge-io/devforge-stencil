/**
 * /account: the signed-in person's hub. Where sign-in lands when nothing asked
 * for a return path, and the one place that always has a sign-out button.
 */

import { Form, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { ArrowRight, KeyRound, UserRound, Users } from "lucide-react";
import { getSiteChrome } from "~/lib/site-chrome.server";
import { ensureCsrfToken } from "~/lib/csrf.server";
import { CsrfInput, CsrfProvider } from "~/components/csrf-input";
import { currentRole, requireAccountUser } from "~/lib/account/session.server";
import { PEOPLE_PATH, SIGN_OUT_PATH } from "~/lib/account/paths";
import { ROLE_INFO } from "~/lib/account/roles";
import { LICENSES_PATH } from "~/lib/licensing/shared";
import { Card, PROJECTS_PATH, Shell, ghostBtn } from "~/components/tools/feature-requests/shell";

export function meta() {
  return [{ title: "Your account · Devforge" }, { name: "robots", content: "noindex" }];
}

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireAccountUser(request);
  const [{ token, setCookie }, chrome, role] = await Promise.all([ensureCsrfToken(request), getSiteChrome(), currentRole(user)]);
  const data = { csrfToken: token, chrome, user: { email: user.email, username: user.username, role } };
  return setCookie ? Response.json(data, { headers: { "Set-Cookie": setCookie } }) : data;
}

export default function Account() {
  const { chrome, csrfToken, user } = useLoaderData<typeof loader>();
  return (
    <CsrfProvider token={csrfToken}>
      <Shell chrome={chrome} backHref="/" backLabel="Home" eyebrow="Account" icon={<UserRound size={13} aria-hidden="true" />}>
        <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Your account</h1>
        <p className="mt-3 text-white/55">
          Signed in as <span className="font-mono text-white/75">{user.email}</span>. One account for every tool on this site.
        </p>
        <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-white/55">
          <span className="inline-flex items-center rounded-full border border-[#f5a524]/40 bg-[#f5a524]/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-[#ffd98a]">
            {ROLE_INFO[user.role].label}
          </span>
          {ROLE_INFO[user.role].summary}
        </p>

        <div className="mt-8 grid gap-5 md:grid-cols-2">
          {user.role === "admin" ? (
            <Card className="md:col-span-2">
              <h2 className="flex items-center gap-2 text-base font-semibold text-white">
                <Users size={15} aria-hidden="true" /> People
              </h2>
              <p className="mt-2 text-sm text-white/55">Everyone with a Devforge account and their role: admin, client or member. Admins only.</p>
              <a href={PEOPLE_PATH} className={`mt-4 ${ghostBtn}`}>
                Manage people <ArrowRight size={14} aria-hidden="true" />
              </a>
            </Card>
          ) : null}
          <Card>
            <h2 className="text-base font-semibold text-white">Feature requests</h2>
            <p className="mt-2 text-sm text-white/55">Projects you created in the feature requests tool: boards, embeds and triage.</p>
            <a href={PROJECTS_PATH} className={`mt-4 ${ghostBtn}`}>
              Your projects <ArrowRight size={14} aria-hidden="true" />
            </a>
          </Card>
          <Card>
            <h2 className="flex items-center gap-2 text-base font-semibold text-white">
              <KeyRound size={15} aria-hidden="true" /> Hammer licences
            </h2>
            <p className="mt-2 text-sm text-white/55">Your licence keys for the Hammer desktop client, which computers use them, and billing.</p>
            <a href={LICENSES_PATH} className={`mt-4 ${ghostBtn}`}>
              Your licences <ArrowRight size={14} aria-hidden="true" />
            </a>
          </Card>
          <Card>
            <h2 className="text-base font-semibold text-white">Projects registered to you</h2>
            <p className="mt-2 text-sm text-white/55">Projects someone else set up with your email as the owner.</p>
            <a href="/project" className={`mt-4 ${ghostBtn}`}>
              Open <ArrowRight size={14} aria-hidden="true" />
            </a>
          </Card>
        </div>

        <Card className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-white">Sign out</h2>
              <p className="mt-1 text-sm text-white/55">Ends your session on this browser.</p>
            </div>
            <Form method="post" action={SIGN_OUT_PATH}>
              <CsrfInput />
              <input type="hidden" name="next" value="/" />
              <button type="submit" className={ghostBtn}>
                Sign out
              </button>
            </Form>
          </div>
        </Card>
      </Shell>
    </CsrfProvider>
  );
}
