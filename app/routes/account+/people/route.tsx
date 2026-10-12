/**
 * /account/people: admins only. Everyone with a Devforge account record and
 * their role (admin, client or member), with a form per row to change it and
 * one to assign a role by email, for people who have an Anvil account but
 * have not signed in here since roles existed. Addresses in ACCOUNT_ADMINS
 * are admins whatever is stored, and nobody can change their own role.
 */

import { Form, useActionData, useLoaderData, useNavigation, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { Users } from "lucide-react";
import { getSiteChrome } from "~/lib/site-chrome.server";
import { ensureCsrfToken, validateCsrf } from "~/lib/csrf.server";
import { CsrfInput, CsrfProvider } from "~/components/csrf-input";
import { requireAccountRole } from "~/lib/account/session.server";
import { assignRoleByEmail, configuredAdmins, isConfiguredAdmin, listAccounts, setAccountRole } from "~/lib/account/accounts.server";
import { ACCOUNT_PATH } from "~/lib/account/paths";
import { ACCOUNT_ROLES, ROLE_INFO, isAccountRole, type AccountRole } from "~/lib/account/roles";
import { Card, Field, Notice, Shell, formatDate, ghostBtn, inputClass, primaryBtn, primaryBtnStyle } from "~/components/tools/feature-requests/shell";

export function meta() {
  return [{ title: "People · Devforge" }, { name: "robots", content: "noindex" }];
}

type Row = { id: string; email: string; username: string; role: AccountRole; lastSignInAt: number; createdAt: number; pinned: boolean };

export async function loader({ request }: LoaderFunctionArgs) {
  const me = await requireAccountRole(request, ["admin"]);
  const [{ token, setCookie }, chrome, accounts] = await Promise.all([ensureCsrfToken(request), getSiteChrome(), listAccounts()]);
  const rows: Row[] = accounts.map((a) => ({
    id: a.id,
    email: a.email,
    username: a.username,
    role: a.role,
    lastSignInAt: a.lastSignInAt,
    createdAt: a.createdAt,
    pinned: isConfiguredAdmin(a.email),
  }));
  const data = { csrfToken: token, chrome, me: me.id, rows, pinnedAdmins: [...configuredAdmins()].sort() };
  return setCookie ? Response.json(data, { headers: { "Set-Cookie": setCookie } }) : data;
}

type ActionData = { error?: string; ok?: string; email?: string };

export async function action({ request }: ActionFunctionArgs) {
  const me = await requireAccountRole(request, ["admin"]);
  const form = await request.formData();
  await validateCsrf(request, form);
  const intent = String(form.get("intent") ?? "");
  const role = String(form.get("role") ?? "");
  if (!isAccountRole(role)) return Response.json({ error: "Pick a role." } satisfies ActionData, { status: 400 });
  const label = ROLE_INFO[role].label.toLowerCase();

  try {
    if (intent === "set-role") {
      const id = String(form.get("user") ?? "");
      if (!id) return Response.json({ error: "No account given." } satisfies ActionData, { status: 400 });
      if (id === me.id) return Response.json({ error: "You cannot change your own role. Ask another admin." } satisfies ActionData, { status: 400 });
      const rec = await setAccountRole(id, role, me.id);
      if (!rec) return Response.json({ error: "That account has no record here yet. Assign the role by email instead." } satisfies ActionData, { status: 404 });
      return { ok: `${rec.email} is now ${label}.` } satisfies ActionData;
    }

    if (intent === "assign-email") {
      const email = String(form.get("email") ?? "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
        return Response.json({ error: "Enter a valid email address.", email } satisfies ActionData, { status: 400 });
      }
      if (email === me.email.trim().toLowerCase()) {
        return Response.json({ error: "You cannot change your own role. Ask another admin.", email } satisfies ActionData, { status: 400 });
      }
      const res = await assignRoleByEmail(email, role, me.id);
      if (res.outcome === "no_account") {
        return Response.json({ error: `No Devforge account uses ${email}. They need to sign up first.`, email } satisfies ActionData, { status: 404 });
      }
      if (res.outcome === "unchanged") return { ok: `${email} is already ${label}.` } satisfies ActionData;
      return {
        ok: res.outcome === "created" ? `${email} is now ${label}. The role applies from their next sign-in here.` : `${email} is now ${label}.`,
      } satisfies ActionData;
    }
  } catch (err) {
    console.error("[account] role change failed", (err as Error).message);
    return Response.json({ error: "The account store did not accept that. Please try again shortly." } satisfies ActionData, { status: 502 });
  }

  return Response.json({ error: "Unknown action." } satisfies ActionData, { status: 400 });
}

const roleChip: Record<AccountRole, string> = {
  admin: "border-[#f5a524]/40 bg-[#f5a524]/10 text-[#ffd98a]",
  client: "border-sky-400/30 bg-sky-400/10 text-sky-200",
  member: "border-white/15 bg-white/[0.04] text-white/60",
};

function RoleChip({ role }: { role: AccountRole }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] ${roleChip[role]}`}>
      {ROLE_INFO[role].label}
    </span>
  );
}

function RoleSelect({ id, name, defaultValue }: { id: string; name: string; defaultValue: AccountRole }) {
  return (
    <select id={id} name={name} defaultValue={defaultValue} className={`${inputClass} w-auto min-w-[8rem] py-1.5`}>
      {ACCOUNT_ROLES.map((r) => (
        <option key={r} value={r} className="bg-[#08060f]">
          {ROLE_INFO[r].label}
        </option>
      ))}
    </select>
  );
}

export default function People() {
  const { chrome, csrfToken, me, rows, pinnedAdmins } = useLoaderData<typeof loader>();
  const data = (useActionData() ?? {}) as ActionData;
  const busy = useNavigation().state === "submitting";
  const counts = rows.reduce<Record<AccountRole, number>>((acc, r) => ((acc[r.role] += 1), acc), { admin: 0, client: 0, member: 0 });

  return (
    <CsrfProvider token={csrfToken}>
      <Shell chrome={chrome} backHref={ACCOUNT_PATH} backLabel="Your account" eyebrow="People" icon={<Users size={13} aria-hidden="true" />} wide>
        <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">People</h1>
        <p className="mt-3 max-w-2xl text-white/55">
          Everyone with a Devforge account record and the role they hold on this site. Roles are Devforge's own, not Anvil's: they decide what a
          person may do on devforge.io.
        </p>
        <dl className="mt-5 grid max-w-2xl gap-3 sm:grid-cols-3">
          {ACCOUNT_ROLES.map((r) => (
            <div key={r} className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
              <dt className="flex items-center justify-between gap-2">
                <RoleChip role={r} />
                <span className="font-mono text-sm text-white/70">{counts[r]}</span>
              </dt>
              <dd className="mt-2 text-xs text-white/45">{ROLE_INFO[r].summary}</dd>
            </div>
          ))}
        </dl>

        {data.error ? (
          <div className="mt-6">
            <Notice>{data.error}</Notice>
          </div>
        ) : null}
        {data.ok ? (
          <div className="mt-6">
            <Notice kind="ok">{data.ok}</Notice>
          </div>
        ) : null}

        <Card className="mt-6">
          <h2 className="text-base font-semibold text-white">Assign a role by email</h2>
          <p className="mt-2 text-sm text-white/55">
            For someone who already has a Devforge account. If they have not signed in since roles existed, their record is created now and the
            role applies from their next sign-in.
          </p>
          <Form method="post" className="mt-4 flex flex-wrap items-end gap-3">
            <CsrfInput />
            <input type="hidden" name="intent" value="assign-email" />
            <div className="min-w-[16rem] flex-1">
              <Field label="Email" htmlFor="assign-email">
                <input id="assign-email" name="email" type="email" autoComplete="off" required defaultValue={data.email ?? ""} className={inputClass} />
              </Field>
            </div>
            <Field label="Role" htmlFor="assign-role">
              <RoleSelect id="assign-role" name="role" defaultValue="client" />
            </Field>
            <button type="submit" disabled={busy} className={primaryBtn} style={primaryBtnStyle}>
              Assign
            </button>
          </Form>
        </Card>

        <Card className="mt-5">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-base font-semibold text-white">Accounts</h2>
            <span className="font-mono text-xs text-white/45">{rows.length} with a record</span>
          </div>
          {pinnedAdmins.length > 0 ? (
            <p className="mt-2 text-xs text-white/45">
              Always admin, set by the server's <span className="font-mono text-white/60">ACCOUNT_ADMINS</span>:{" "}
              <span className="font-mono text-white/60">{pinnedAdmins.join(", ")}</span>
            </p>
          ) : (
            <p className="mt-2 text-xs text-white/45">
              No <span className="font-mono text-white/60">ACCOUNT_ADMINS</span> is set on the server, so admins exist only as stored roles.
            </p>
          )}
          {rows.length === 0 ? (
            <p className="mt-4 text-sm text-white/55">No records yet. A record appears when someone signs in, or when you assign a role by email above.</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[40rem] text-left text-sm">
                <thead>
                  <tr className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/45">
                    <th className="pb-2 pr-4 font-normal">Person</th>
                    <th className="pb-2 pr-4 font-normal">Role</th>
                    <th className="pb-2 pr-4 font-normal">Last sign-in</th>
                    <th className="pb-2 font-normal">Change</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06]">
                  {rows.map((r) => (
                    <tr key={r.id} className="align-top">
                      <td className="py-3 pr-4">
                        <div className="font-mono text-white/80">{r.email || r.id}</div>
                        <div className="mt-0.5 text-xs text-white/40">
                          {r.username ? `@${r.username}` : "no username yet"}
                          {r.id === me ? " · you" : ""}
                        </div>
                      </td>
                      <td className="py-3 pr-4">
                        <RoleChip role={r.role} />
                        {r.pinned && r.role !== "admin" ? <div className="mt-1 text-xs text-white/40">admin by ACCOUNT_ADMINS</div> : null}
                      </td>
                      <td className="py-3 pr-4 text-white/60">{r.lastSignInAt ? formatDate(r.lastSignInAt) : "never"}</td>
                      <td className="py-3">
                        {r.id === me ? (
                          <span className="text-xs text-white/40">Another admin changes yours.</span>
                        ) : (
                          <Form method="post" className="flex flex-wrap items-center gap-2">
                            <CsrfInput />
                            <input type="hidden" name="intent" value="set-role" />
                            <input type="hidden" name="user" value={r.id} />
                            <label htmlFor={`role-${r.id}`} className="sr-only">
                              Role for {r.email}
                            </label>
                            <RoleSelect id={`role-${r.id}`} name="role" defaultValue={r.role} />
                            <button type="submit" disabled={busy} className={ghostBtn}>
                              Save
                            </button>
                          </Form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </Shell>
    </CsrfProvider>
  );
}
