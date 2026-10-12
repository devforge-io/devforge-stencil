/**
 * /account/sign-in: the site-wide Devforge sign-in, by emailed code only. The
 * person enters their email, Anvil sends a one-time code (the request names
 * the app from `ANVIL_APP`, default `devforge`, so its email template and OTP
 * settings apply) and verifying it signs them in; on success the app sets its
 * own session cookie, enrols the person as a member of the app, reads their
 * Devforge role and returns them to `next` (any same-site path, default
 * /account). Stencil's `loginUrl` setting points /login here. Passwords are
 * never used by the site; an unknown address is created on verify when Anvil
 * allows OTP registration, exactly as on the sign-up page.
 */

import { Form, redirect, useActionData, useLoaderData, useNavigation, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { UserRound } from "lucide-react";
import { getSiteChrome } from "~/lib/site-chrome.server";
import { ensureCsrfToken, validateCsrf } from "~/lib/csrf.server";
import { CsrfInput, CsrfProvider } from "~/components/csrf-input";
import { AnvilError, anvilOtpRequest, anvilOtpVerify, identityFromToken } from "~/lib/feature-requests/anvil.server";
import { accountSignInHeaders, getAccountUser } from "~/lib/account/session.server";
import { accountAppSlug, ensureAccountMember } from "~/lib/account/anvil-app.server";
import { roleForSignIn } from "~/lib/account/accounts.server";
import { safeNext, signInHref, signUpHref } from "~/lib/account/paths";
import { clientIp, rateLimited } from "~/lib/feature-requests/http.server";
import { Card, Field, Notice, Shell, ghostBtn, inputClass, primaryBtn, primaryBtnStyle } from "~/components/tools/feature-requests/shell";

export function meta() {
  return [{ title: "Sign in · Devforge" }, { name: "robots", content: "noindex" }];
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));
  if (await getAccountUser(request)) throw redirect(next);
  const [{ token, setCookie }, chrome] = await Promise.all([ensureCsrfToken(request), getSiteChrome()]);
  const data = { csrfToken: token, chrome, next, email: url.searchParams.get("email") ?? "" };
  return setCookie ? Response.json(data, { headers: { "Set-Cookie": setCookie } }) : data;
}

type ActionData = { error?: string; stage?: "code"; email?: string; notice?: string };

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  await validateCsrf(request, form);
  const intent = String(form.get("intent") ?? "request");
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const next = safeNext(String(form.get("next") ?? ""));
  const ip = clientIp(request);
  if (rateLimited(`account:signin:${ip}`, 12, 10 * 60_000)) {
    return Response.json({ error: "Too many attempts. Try again in a few minutes.", email } satisfies ActionData, { status: 429 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    return Response.json({ error: "Enter the email address you signed up with.", email } satisfies ActionData, { status: 400 });
  }

  try {
    if (intent === "verify") {
      const code = String(form.get("code") ?? "").trim();
      if (!code) return Response.json({ error: "Enter the code from the email.", stage: "code", email } satisfies ActionData, { status: 400 });
      const tokens = await anvilOtpVerify(email, code);
      const identity = identityFromToken(tokens.accessToken);
      if (!identity) throw new AnvilError("Anvil returned an unreadable token", 502);
      const [, role] = await Promise.all([ensureAccountMember(identity.sub), roleForSignIn(identity)]);
      return redirect(next, { headers: await accountSignInHeaders(identity, tokens, role) });
    }
    await anvilOtpRequest(email, accountAppSlug());
    return { stage: "code", email, notice: `A sign-in code is on its way to ${email}. Enter it below.` } satisfies ActionData;
  } catch (err) {
    const e = err as AnvilError;
    const status = typeof e.status === "number" ? e.status : 500;
    const verifying = intent === "verify";
    let message = verifying ? "Sign-in failed. Please try again." : "Could not send the code. Please try again.";
    if (status === 401 || status === 403) {
      message = verifying
        ? "That code is not valid or has expired. Ask for a new one if it has been a while."
        : "Anvil refused the code request. Check that email sign-in is enabled on the server.";
    } else if (status === 503) message = "Email sending is not configured on the Anvil server, so codes cannot go out right now.";
    else if (status === 429) message = "Too many attempts. Try again in a few minutes.";
    const body: ActionData = { error: message, email };
    if (verifying) body.stage = "code";
    return Response.json(body, { status: status >= 400 && status < 600 ? status : 500 });
  }
}

export default function SignIn() {
  const { chrome, csrfToken, next, email: emailParam } = useLoaderData<typeof loader>();
  const data = (useActionData() ?? {}) as ActionData;
  const busy = useNavigation().state === "submitting";
  const email = data.email ?? emailParam;
  const codeStage = data.stage === "code";

  return (
    <CsrfProvider token={csrfToken}>
      <Shell chrome={chrome} backHref="/" backLabel="Home" eyebrow="Account" icon={<UserRound size={13} aria-hidden="true" />}>
        <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Sign in</h1>
        <p className="mt-3 text-white/55">
          One Devforge account for every tool on this site. We email you a one-time code; there is no password. New here?{" "}
          <a href={signUpHref(next)} className="text-[#ffd98a] underline-offset-2 hover:underline">
            Create an account
          </a>
          .
        </p>
        <Card className="mt-8 max-w-md">
          {codeStage ? (
            <Form method="post" className="space-y-4">
              <CsrfInput />
              <input type="hidden" name="intent" value="verify" />
              <input type="hidden" name="next" value={next} />
              <input type="hidden" name="email" value={email} />
              {data.notice ? <Notice kind="info">{data.notice}</Notice> : null}
              <Field label={`Code sent to ${email}`} htmlFor="code" hint="The code works once and expires after a few minutes.">
                <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" required className={inputClass} />
              </Field>
              {data.error ? <Notice>{data.error}</Notice> : null}
              <div className="flex flex-wrap gap-3">
                <button type="submit" disabled={busy} className={primaryBtn} style={primaryBtnStyle}>
                  Verify and sign in
                </button>
                <a href={signInHref(next)} className={ghostBtn}>
                  Start over
                </a>
              </div>
            </Form>
          ) : (
            <Form method="post" className="space-y-4">
              <CsrfInput />
              <input type="hidden" name="intent" value="request" />
              <input type="hidden" name="next" value={next} />
              <Field label="Email" htmlFor="email" hint="We email you a one-time code. No password needed.">
                <input id="email" name="email" type="email" autoComplete="email" required defaultValue={email} className={inputClass} />
              </Field>
              {data.error ? <Notice>{data.error}</Notice> : null}
              <button type="submit" disabled={busy} className={primaryBtn} style={primaryBtnStyle}>
                Email me a code
              </button>
            </Form>
          )}
        </Card>
      </Shell>
    </CsrfProvider>
  );
}
