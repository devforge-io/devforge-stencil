/**
 * /account: the signed-in person's hub. Where sign-in lands when nothing asked
 * for a return path, and the one place that always has a sign-out button.
 */

import { Form, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { ArrowRight, UserRound } from "lucide-react";
import { getSiteChrome } from "~/lib/site-chrome.server";
import { ensureCsrfToken } from "~/lib/csrf.server";
import { CsrfInput, CsrfProvider } from "~/components/csrf-input";
import { requireAccountUser } from "~/lib/account/session.server";
import { SIGN_OUT_PATH } from "~/lib/account/paths";
import { Card, PROJECTS_PATH, Shell, ghostBtn } from "~/components/tools/feature-requests/shell";

export function meta() {
  return [{ title: "Your account · Devforge" }, { name: "robots", content: "noindex" }];
}

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireAccountUser(request);
  const [{ token, setCookie }, chrome] = await Promise.all([ensureCsrfToken(request), getSiteChrome()]);
  const data = { csrfToken: token, chrome, user: { email: user.email, username: user.username } };
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

        <div className="mt-8 grid gap-5 md:grid-cols-2">
          <Card>
            <h2 className="text-base font-semibold text-white">Feature requests</h2>
            <p className="mt-2 text-sm text-white/55">Projects you created in the feature requests tool: boards, embeds and triage.</p>
            <a href={PROJECTS_PATH} className={`mt-4 ${ghostBtn}`}>
              Your projects <ArrowRight size={14} aria-hidden="true" />
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
