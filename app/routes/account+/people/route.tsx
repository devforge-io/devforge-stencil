/**
 * /account/people: admins only. Everyone with a Devforge account (members of
 * the account app, plus anyone holding an assigned role) with the role they
 * hold, a select per row to change it, a form to assign a role by email and
 * one to add a role. Roles live in app_devforge.roles (UUID keys, a slug for
 * the code), assignments in app_devforge.accounts; names and emails come from
 * auth.users. Addresses in ACCOUNT_ADMINS are admin whatever is stored, and
 * nobody changes their own.
 */

import { Form, useActionData, useLoaderData, useNavigation, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { Users } from "lucide-react";
import { getSiteChrome } from "~/lib/site-chrome.server";
import { ensureCsrfToken, validateCsrf } from "~/lib/csrf.server";
import { CsrfInput, CsrfProvider } from "~/components/csrf-input";
import { requireAccountRole } from "~/lib/account/session.server";
import { assignRoleByEmail, configuredAdmins, createRole, listPeople, listRoles, setAccountRole } from "~/lib/account/accounts.server";
import { ACCOUNT_PATH } from "~/lib/account/paths";
import { ADMIN_ROLE, isRoleId, type RoleDef, type RoleSlug } from "~/lib/account/roles";
import { Card, Field, Notice, Shell, fieldClass, formatDate, ghostBtn, inputClass, primaryBtn, primaryBtnStyle } from "~/components/tools/feature-requests/shell";

export function meta() {
  return [{ title: "People · Devforge" }, { name: "robots", content: "noindex" }];
}

export async function loader({ request }: LoaderFunctionArgs) {
  const me = await requireAccountRole(request, [ADMIN_ROLE]);
  const [{ token, setCookie }, chrome, roles, people] = await Promise.all([ensureCsrfToken(request), getSiteChrome(), listRoles(), listPeople()]);
  const data = { csrfToken: token, chrome, me: me.id, roles, people, pinnedAdmins: [...configuredAdmins()].sort() };
  return setCookie ? Response.json(data, { headers: { "Set-Cookie": setCookie } }) : data;
}

type ActionData = { error?: string; ok?: string; email?: string; roleName?: string; roleDescription?: string };

export async function action({ request }: ActionFunctionArgs) {
  const me = await requireAccountRole(request, [ADMIN_ROLE]);
  const form = await request.formData();
  await validateCsrf(request, form);
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "add-role") {
      const roleName = String(form.get("name") ?? "");
      const roleDescription = String(form.get("description") ?? "");
      const res = await createRole({ name: roleName, description: roleDescription }, me.id);
      if (res.outcome === "invalid") return Response.json({ error: res.reason, roleName, roleDescription } satisfies ActionData, { status: 400 });
      if (res.outcome === "exists") return Response.json({ error: `There is already a role with the slug ${res.role?.slug}.`, roleName, roleDescription } satisfies ActionData, { status: 409 });
      return { ok: `Added the role ${res.role?.name} (${res.role?.slug}).` } satisfies ActionData;
    }

    const roleId = String(form.get("role") ?? "");
    if (!isRoleId(roleId)) return Response.json({ error: "Pick a role." } satisfies ActionData, { status: 400 });
    const role = (await listRoles()).find((r) => r.id === roleId);
    if (!role) return Response.json({ error: "That role does not exist." } satisfies ActionData, { status: 400 });
    const label = role.name.toLowerCase();

    if (intent === "set-role") {
      const id = String(form.get("user") ?? "");
      if (!id) return Response.json({ error: "No account given." } satisfies ActionData, { status: 400 });
      if (id === me.id) return Response.json({ error: "You cannot change your own role. Ask another admin." } satisfies ActionData, { status: 400 });
      await setAccountRole(id, roleId, me.id);
      return { ok: `Role saved: ${label}.` } satisfies ActionData;
    }

    if (intent === "assign-email") {
      const email = String(form.get("email") ?? "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
        return Response.json({ error: "Enter a valid email address.", email } satisfies ActionData, { status: 400 });
      }
      if (email === me.email.trim().toLowerCase()) {
        return Response.json({ error: "You cannot change your own role. Ask another admin.", email } satisfies ActionData, { status: 400 });
      }
      const res = await assignRoleByEmail(email, roleId, me.id);
      if (res.outcome === "no_account") {
        return Response.json({ error: `No Anvil account uses ${email}. They need to sign up first.`, email } satisfies ActionData, { status: 404 });
      }
      return { ok: res.outcome === "unchanged" ? `${email} is already ${label}.` : `${email} is now ${label}.` } satisfies ActionData;
    }
  } catch (err) {
    console.error("[account] role change failed", (err as Error).message);
    return Response.json({ error: "The account store did not accept that. Please try again shortly." } satisfies ActionData, { status: 502 });
  }

  return Response.json({ error: "Unknown action." } satisfies ActionData, { status: 400 });
}

const chipTone: Record<string, string> = {
  admin: "border-[#f5a524]/40 bg-[#f5a524]/10 text-[#ffd98a]",
  client: "border-sky-400/30 bg-sky-400/10 text-sky-200",
  member: "border-white/15 bg-white/[0.04] text-white/60",
};
const customTone = "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";

function RoleChip({ role, roles }: { role: RoleSlug; roles: RoleDef[] }) {
  const def = roles.find((r) => r.slug === role);
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] ${chipTone[role] ?? customTone}`}>
      {def?.name ?? role}
    </span>
  );
}

/** Options carry the role UUID; `defaultValue` is a UUID too. */
function RoleSelect({ id, name, defaultValue, roles }: { id: string; name: string; defaultValue: string; roles: RoleDef[] }) {
  return (
    <select id={id} name={name} defaultValue={defaultValue} className={`${fieldClass} min-w-[8rem]`}>
      {roles.map((r) => (
        <option key={r.id} value={r.id} className="bg-[#08060f]">
          {r.name}
        </option>
      ))}
    </select>
  );
}

export default function People() {
  const { chrome, csrfToken, me, roles, people, pinnedAdmins } = useLoaderData<typeof loader>();
  const data = (useActionData() ?? {}) as ActionData;
  const busy = useNavigation().state === "submitting";
  const counts = new Map<string, number>();
  for (const p of people) counts.set(p.role, (counts.get(p.role) ?? 0) + 1);
  const clientRoleId = roles.find((r) => r.slug === "client")?.id ?? roles[0]?.id ?? "";

  return (
    <CsrfProvider token={csrfToken}>
      <Shell chrome={chrome} backHref={ACCOUNT_PATH} backLabel="Your account" eyebrow="People" icon={<Users size={13} aria-hidden="true" />} wide>
        <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">People</h1>
        <p className="mt-3 max-w-2xl text-white/55">
          Everyone with a Devforge account and the role they hold on this site. Roles are Devforge's own, not Anvil's: they decide what a person
          may do on devforge.io.
        </p>

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
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-base font-semibold text-white">Roles</h2>
            <span className="font-mono text-xs text-white/45">app_devforge.roles</span>
          </div>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {roles.map((r) => (
              <li key={r.id} className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <RoleChip role={r.slug} roles={roles} />
                  <span className="font-mono text-sm text-white/70">{counts.get(r.slug) ?? 0}</span>
                </div>
                <p className="mt-2 text-xs text-white/45">{r.description || "No description."}</p>
                <p className="mt-1 break-all font-mono text-[10px] text-white/30">
                  {r.slug}
                  {r.builtin ? " · built in" : ""} · {r.id}
                </p>
              </li>
            ))}
          </ul>
          <Form method="post" className="mt-5 flex flex-wrap items-end gap-3 border-t border-white/[0.06] pt-5">
            <CsrfInput />
            <input type="hidden" name="intent" value="add-role" />
            <div className="min-w-[12rem]">
              <Field label="New role" htmlFor="role-name">
                <input id="role-name" name="name" type="text" required minLength={2} maxLength={40} defaultValue={data.roleName ?? ""} className={inputClass} />
              </Field>
            </div>
            <div className="min-w-[16rem] flex-1">
              <Field label="Description" htmlFor="role-description">
                <input id="role-description" name="description" type="text" maxLength={200} defaultValue={data.roleDescription ?? ""} className={inputClass} />
              </Field>
            </div>
            <button type="submit" disabled={busy} className={`${ghostBtn} py-2.5`}>
              Add role
            </button>
            <p className="basis-full text-xs text-white/40">Gets a UUID; its slug is made from the name.</p>
          </Form>
        </Card>

        <Card className="mt-5">
          <h2 className="text-base font-semibold text-white">Assign a role by email</h2>
          <p className="mt-2 text-sm text-white/55">For anyone with an Anvil account, whether or not they appear in the list below.</p>
          <Form method="post" className="mt-4 flex flex-wrap items-end gap-3">
            <CsrfInput />
            <input type="hidden" name="intent" value="assign-email" />
            <div className="min-w-[16rem] flex-1">
              <Field label="Email" htmlFor="assign-email">
                <input id="assign-email" name="email" type="email" autoComplete="off" required defaultValue={data.email ?? ""} className={inputClass} />
              </Field>
            </div>
            <Field label="Role" htmlFor="assign-role">
              <RoleSelect id="assign-role" name="role" defaultValue={clientRoleId} roles={roles} />
            </Field>
            <button type="submit" disabled={busy} className={primaryBtn} style={primaryBtnStyle}>
              Assign
            </button>
          </Form>
        </Card>

        <Card className="mt-5">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-base font-semibold text-white">Accounts</h2>
            <span className="font-mono text-xs text-white/45">{people.length} people</span>
          </div>
          {pinnedAdmins.length > 0 ? (
            <p className="mt-2 text-xs text-white/45">
              Always admin, set by the server's <span className="font-mono text-white/60">ACCOUNT_ADMINS</span>:{" "}
              <span className="font-mono text-white/60">{pinnedAdmins.join(", ")}</span>
            </p>
          ) : (
            <p className="mt-2 text-xs text-white/45">
              No <span className="font-mono text-white/60">ACCOUNT_ADMINS</span> is set on the server, so admins exist only as assigned roles.
            </p>
          )}
          {people.length === 0 ? (
            <p className="mt-4 text-sm text-white/55">Nobody has signed in yet.</p>
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
                  {people.map((p) => (
                    <tr key={p.id} className="align-top">
                      <td className="py-3 pr-4">
                        <div className="font-mono text-white/80">{p.email || (p.username ? `@${p.username}` : p.id)}</div>
                        <div className="mt-0.5 text-xs text-white/40">
                          {p.email ? (p.username ? `@${p.username}` : "no username") : "no email on the Anvil account"}
                          {p.id === me ? " · you" : ""}
                        </div>
                      </td>
                      <td className="py-3 pr-4">
                        <RoleChip role={p.role} roles={roles} />
                        <div className="mt-1 text-xs text-white/40">{p.pinned ? "by ACCOUNT_ADMINS" : p.assigned ? "assigned" : "default"}</div>
                      </td>
                      <td className="py-3 pr-4 text-white/60">{p.lastSignedInAt ? formatDate(p.lastSignedInAt) : "never"}</td>
                      <td className="py-3">
                        {p.id === me ? (
                          <span className="text-xs text-white/40">Another admin changes yours.</span>
                        ) : (
                          <Form method="post" className="flex flex-wrap items-center gap-2">
                            <CsrfInput />
                            <input type="hidden" name="intent" value="set-role" />
                            <input type="hidden" name="user" value={p.id} />
                            <label htmlFor={`role-${p.id}`} className="sr-only">
                              Role for {p.email || p.username || p.id}
                            </label>
                            <RoleSelect id={`role-${p.id}`} name="role" defaultValue={p.roleId} roles={roles} />
                            <button type="submit" disabled={busy} className={`${ghostBtn} py-2.5`}>
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
