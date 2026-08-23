/**
 * /tools/feature-requests/sign-in: password or emailed code, both backed by
 * Anvil's auth endpoints. On success the app sets its own session cookie.
 */

import { Form, redirect, useActionData, useLoaderData, useNavigation, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { getSiteChrome } from "~/lib/site-chrome.server";
import { ensureCsrfToken, validateCsrf } from "~/lib/csrf.server";
import { CsrfInput, CsrfProvider } from "~/components/csrf-input";
import { AnvilError, anvilLogin, anvilOtpRequest, anvilOtpVerify, identityFromToken } from "~/lib/feature-requests/anvil.server";
import { createFrSession, getFrUser, safeNext } from "~/lib/feature-requests/session.server";
import { clientIp, rateLimited } from "~/lib/feature-requests/http.server";
import { Card, Field, Notice, Shell, TOOL_PATH, ghostBtn, inputClass, primaryBtn, primaryBtnStyle } from "~/components/tools/feature-requests/shell";

export function meta() {
  return [{ title: "Sign in · Feature requests · Devforge" }, { name: "robots", content: "noindex" }];
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));
  if (await getFrUser(request)) throw redirect(next);
  const [{ token, setCookie }, chrome] = await Promise.all([ensureCsrfToken(request), getSiteChrome()]);
  const data = { csrfToken: token, chrome, next, email: url.searchParams.get("email") ?? "" };
  return setCookie ? Response.json(data, { headers: { "Set-Cookie": setCookie } }) : data;
}

type ActionData = { error?: string; stage?: "code"; email?: string; notice?: string };

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  await validateCsrf(request, form);
  const intent = String(form.get("intent") ?? "password");
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const next = safeNext(String(form.get("next") ?? ""));
  const ip = clientIp(request);
  if (rateLimited(`fr:signin:${ip}`, 12, 10 * 60_000)) {
    return Response.json({ error: "Too many attempts. Try again in a few minutes." } satisfies ActionData, { status: 429 });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: "Enter the email address you signed up with." } satisfies ActionData, { status: 400 });
  }

  try {
    if (intent === "otp-request") {
      await anvilOtpRequest(email);
      return { stage: "code", email, notice: "If that address has an account, a sign-in code is on its way. Enter it below." } satisfies ActionData;
    }
    if (intent === "otp-verify") {
      const code = String(form.get("code") ?? "").trim();
      if (!code) return Response.json({ error: "Enter the code from the email.", stage: "code", email } satisfies ActionData, { status: 400 });
      const tokens = await anvilOtpVerify(email, code);
      const identity = identityFromToken(tokens.accessToken);
      if (!identity) throw new AnvilError("Anvil returned an unreadable token", 502);
      return redirect(next, { headers: { "Set-Cookie": await createFrSession(identity, tokens) } });
    }
    const password = String(form.get("password") ?? "");
    if (!password) return Response.json({ error: "Enter your password." } satisfies ActionData, { status: 400 });
    const tokens = await anvilLogin(email, password);
    const identity = identityFromToken(tokens.accessToken);
    if (!identity) throw new AnvilError("Anvil returned an unreadable token", 502);
    return redirect(next, { headers: { "Set-Cookie": await createFrSession(identity, tokens) } });
  } catch (err) {
    const e = err as AnvilError;
    const status = typeof e.status === "number" ? e.status : 500;
    let message = "Sign-in failed. Please try again.";
    if (status === 401 || status === 403) message = intent === "otp-verify" ? "That code is not valid or has expired." : "Email or password is wrong.";
    else if (status === 503) message = intent.startsWith("otp") ? "Email codes are not available right now. Use your password instead." : "The database is not reachable right now. Please try again shortly.";
    else if (status === 429) message = "Too many attempts. Try again in a few minutes.";
    const body: ActionData = { error: message, email };
    if (intent === "otp-verify") body.stage = "code";
    return Response.json(body, { status: status >= 400 && status < 600 ? status : 500 });
  }
}

export default function SignIn() {
  const { chrome, csrfToken, next, email: emailParam } = useLoaderData<typeof loader>();
  const data = (useActionData() ?? {}) as ActionData;
  const nav = useNavigation();
  const busy = nav.state === "submitting";
  const email = data.email ?? emailParam;
  const codeStage = data.stage === "code";

  return (
    <CsrfProvider token={csrfToken}>
      <Shell chrome={chrome} backHref={TOOL_PATH} backLabel="Feature requests">
        <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Sign in</h1>
        <p className="mt-3 text-white/55">
          New here?{" "}
          <a href={`${TOOL_PATH}/sign-up`} className="text-[#ffd98a] underline-offset-2 hover:underline">
            Create an account
          </a>
          .
        </p>

        <div className="mt-8 grid gap-5 md:grid-cols-2">
          <Card>
            <h2 className="text-base font-semibold text-white">With your password</h2>
            <Form method="post" className="mt-4 space-y-4">
              <CsrfInput />
              <input type="hidden" name="intent" value="password" />
              <input type="hidden" name="next" value={next} />
              <Field label="Email" htmlFor="email">
                <input id="email" name="email" type="email" autoComplete="email" required defaultValue={email} className={inputClass} />
              </Field>
              <Field label="Password" htmlFor="password">
                <input id="password" name="password" type="password" autoComplete="current-password" required className={inputClass} />
              </Field>
              {data.error && !codeStage ? <Notice>{data.error}</Notice> : null}
              <button type="submit" disabled={busy} className={primaryBtn} style={primaryBtnStyle}>
                Sign in
              </button>
            </Form>
          </Card>

          <Card>
            <h2 className="text-base font-semibold text-white">With an emailed code</h2>
            {codeStage ? (
              <Form method="post" className="mt-4 space-y-4">
                <CsrfInput />
                <input type="hidden" name="intent" value="otp-verify" />
                <input type="hidden" name="next" value={next} />
                <input type="hidden" name="email" value={email} />
                {data.notice ? <Notice kind="info">{data.notice}</Notice> : null}
                <Field label={`Code sent to ${email}`} htmlFor="code">
                  <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" required className={inputClass} />
                </Field>
                {data.error ? <Notice>{data.error}</Notice> : null}
                <div className="flex flex-wrap gap-3">
                  <button type="submit" disabled={busy} className={primaryBtn} style={primaryBtnStyle}>
                    Verify and sign in
                  </button>
                  <a href={`${TOOL_PATH}/sign-in?next=${encodeURIComponent(next)}`} className={ghostBtn}>
                    Start over
                  </a>
                </div>
              </Form>
            ) : (
              <Form method="post" className="mt-4 space-y-4">
                <CsrfInput />
                <input type="hidden" name="intent" value="otp-request" />
                <input type="hidden" name="next" value={next} />
                <Field label="Email" htmlFor="otp-email" hint="We email you a one-time code. No password needed.">
                  <input id="otp-email" name="email" type="email" autoComplete="email" required defaultValue={email} className={inputClass} />
                </Field>
                <button type="submit" disabled={busy} className={ghostBtn}>
                  Email me a code
                </button>
              </Form>
            )}
          </Card>
        </div>
      </Shell>
    </CsrfProvider>
  );
}
