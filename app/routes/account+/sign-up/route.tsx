/**
 * /account/sign-up: creates the Anvil user (admin-only register endpoint,
 * called with the app's service credentials) in the Anvil app named by
 * `ANVIL_APP` (default `devforge`, so its email templates apply), enrols
 * them as a member of it, then signs them in and returns them to `next`
 * (default /account).
 */

import { Form, redirect, useActionData, useLoaderData, useNavigation, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { UserRound } from "lucide-react";
import { getSiteChrome } from "~/lib/site-chrome.server";
import { ensureCsrfToken, validateCsrf } from "~/lib/csrf.server";
import { CsrfInput, CsrfProvider } from "~/components/csrf-input";
import { AnvilError, anvilLogin, anvilRegister, identityFromToken } from "~/lib/feature-requests/anvil.server";
import { accountSignInHeaders, getAccountUser } from "~/lib/account/session.server";
import { accountAppSlug, ensureAccountMember } from "~/lib/account/anvil-app.server";
import { roleForSignIn } from "~/lib/account/accounts.server";
import { safeNext, signInHref } from "~/lib/account/paths";
import { clientIp, rateLimited } from "~/lib/feature-requests/http.server";
import { Card, Field, Notice, Shell, inputClass, primaryBtn, primaryBtnStyle } from "~/components/tools/feature-requests/shell";

export function meta() {
  return [{ title: "Create an account · Devforge" }, { name: "robots", content: "noindex" }];
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));
  if (await getAccountUser(request)) throw redirect(next);
  const [{ token, setCookie }, chrome] = await Promise.all([ensureCsrfToken(request), getSiteChrome()]);
  const data = { csrfToken: token, chrome, next };
  return setCookie ? Response.json(data, { headers: { "Set-Cookie": setCookie } }) : data;
}

type ActionData = { error?: string; email?: string };

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  await validateCsrf(request, form);
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm") ?? "");
  const next = safeNext(String(form.get("next") ?? ""));
  const ip = clientIp(request);
  if (rateLimited(`account:signup:${ip}`, 6, 60 * 60_000)) {
    return Response.json({ error: "Too many sign-ups from this connection. Try again later.", email } satisfies ActionData, { status: 429 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    return Response.json({ error: "Enter a valid email address.", email } satisfies ActionData, { status: 400 });
  }
  if (password.length < 10) return Response.json({ error: "Use a password of at least 10 characters.", email } satisfies ActionData, { status: 400 });
  if (password.length > 200) return Response.json({ error: "That password is too long.", email } satisfies ActionData, { status: 400 });
  if (password !== confirm) return Response.json({ error: "The two passwords do not match.", email } satisfies ActionData, { status: 400 });

  try {
    await anvilRegister(email, password, accountAppSlug());
  } catch (err) {
    const e = err as AnvilError;
    if (e.status === 409) {
      return Response.json({ error: "There is already an account for that email. Sign in instead.", email } satisfies ActionData, { status: 409 });
    }
    const message =
      e.status === 503
        ? "The database is not reachable right now. Please try again shortly."
        : e.status === 403
          ? "Password sign-up is not available: the app's Anvil service key does not have the admin role. Use the emailed code on the sign-in page instead."
          : e.status === 401
            ? "Password sign-up is not available: Anvil rejected the app's service key (invalid, revoked, or changed without restarting the app). Use the emailed code on the sign-in page instead."
            : "Could not create the account. Please try again.";
    return Response.json({ error: message, email } satisfies ActionData, { status: e.status && e.status >= 400 ? e.status : 500 });
  }
  try {
    const tokens = await anvilLogin(email, password);
    const identity = identityFromToken(tokens.accessToken);
    if (!identity) throw new AnvilError("Anvil returned an unreadable token", 502);
    const [, role] = await Promise.all([ensureAccountMember(identity.sub, { fresh: true }), roleForSignIn(identity)]);
    return redirect(next, { headers: await accountSignInHeaders(identity, tokens, role) });
  } catch {
    // Membership is ensured on the next sign-in if the login step failed here.
    return redirect(signInHref(next, email));
  }
}

export default function SignUp() {
  const { chrome, csrfToken, next } = useLoaderData<typeof loader>();
  const data = (useActionData() ?? {}) as ActionData;
  const busy = useNavigation().state === "submitting";
  return (
    <CsrfProvider token={csrfToken}>
      <Shell chrome={chrome} backHref="/" backLabel="Home" eyebrow="Account" icon={<UserRound size={13} aria-hidden="true" />}>
        <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Create an account</h1>
        <p className="mt-3 text-white/55">
          One Devforge account for every tool on this site. Already have one?{" "}
          <a href={signInHref(next)} className="text-[#ffd98a] underline-offset-2 hover:underline">
            Sign in
          </a>
          .
        </p>
        <Card className="mt-8 max-w-md">
          <Form method="post" className="space-y-4">
            <CsrfInput />
            <input type="hidden" name="next" value={next} />
            <Field label="Email" htmlFor="email" hint="Your email is your username. We only use it to sign you in.">
              <input id="email" name="email" type="email" autoComplete="email" required defaultValue={data.email ?? ""} className={inputClass} />
            </Field>
            <Field label="Password" htmlFor="password" hint="At least 10 characters.">
              <input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required className={inputClass} />
            </Field>
            <Field label="Confirm password" htmlFor="confirm">
              <input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={10} required className={inputClass} />
            </Field>
            {data.error ? <Notice>{data.error}</Notice> : null}
            <button type="submit" disabled={busy} className={primaryBtn} style={primaryBtnStyle}>
              Create account
            </button>
            <p className="text-xs text-white/40">
              Accounts are stored in Devforge's Anvil DB. You can also sign in later with an emailed code instead of the password.
            </p>
          </Form>
        </Card>
      </Shell>
    </CsrfProvider>
  );
}
