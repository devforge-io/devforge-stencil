import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  assignRoleByEmail,
  configuredAdmins,
  createRole,
  describeRole,
  effectiveRole,
  getAccountRecord,
  getAccountRole,
  getRole,
  getRoleBySlug,
  listPeople,
  listRoles,
  resetAccountsCache,
  roleForSignIn,
  setAccountRole,
} from "./accounts.server";
import { resetAccountAppCache } from "./anvil-app.server";
import { isRoleId } from "./roles";

process.env.ANVIL_URL = "https://anvil.test";
process.env.ANVIL_SERVICE_KEY = "test-key";

const APP_ID = "f678da77-eb48-4f4c-9cad-c2f412f36bfa";

type Call = { method: string; path: string; body?: unknown; auth: string | null };
type Reply = { status?: number; body?: unknown };
type Doc = { key: string; body: Record<string, unknown>; created_at: number; updated_at: number; version: number };
type User = { id: string; email: string; username: string; last_signed_in_on?: number };

const realFetch = globalThis.fetch;
const realError = console.error;

/**
 * A fake Anvil: the devforge app with `members`, a read-only auth.users
 * table, and document collections for app_devforge.roles and .accounts with
 * conditional PUTs.
 */
function anvil(users: User[] = [], members: string[] = []) {
  const colls = new Map<string, Map<string, Doc>>();
  const coll = (name: string) => colls.get(name) ?? colls.set(name, new Map()).get(name)!;
  const calls: Call[] = [];
  const matches = (doc: Doc, f: any): boolean => {
    if (!f) return true;
    if (f.op === "eq") return doc.body[f.field] === f.value;
    if (f.op === "in") return (f.values as unknown[]).includes(doc.body[f.field]);
    if (f.op === "and") return f.conditions.every((c: unknown) => matches(doc, c));
    throw new Error(`fake anvil: unsupported filter ${JSON.stringify(f)}`);
  };
  const userDocs = (): Doc[] => users.map((u) => ({ key: u.username, body: { ...u }, created_at: 0, updated_at: 0, version: 1 }));
  const memberDocs = (): Doc[] =>
    members.map((u) => ({ key: `${APP_ID}:${u}`, body: { app_id: APP_ID, user_id: u, privilege: "reader" }, created_at: 0, updated_at: 0, version: 1 }));

  const handle = (c: Call): Reply => {
    assert.equal(c.auth, "Bearer test-key");
    if (c.method === "GET" && c.path === "/apps/devforge") return { body: { id: APP_ID, slug: "devforge" } };
    let m = c.path.match(/^\/docs\/([a-z_.]+)\/query$/);
    if (m && c.method === "POST") {
      const filter = (c.body as { filter?: unknown }).filter;
      const source = m[1] === "auth.users" ? userDocs() : m[1] === "auth.app_members" ? memberDocs() : [...coll(m[1]).values()];
      return { body: { documents: source.filter((d) => matches(d, filter)) } };
    }
    m = c.path.match(/^\/docs\/(app_devforge\.[a-z]+)$/);
    if (m && c.method === "POST") return { body: { created: true } };
    m = c.path.match(/^\/docs\/(app_devforge\.[a-z]+)\/([^/]+)$/);
    if (m) {
      const store = coll(m[1]);
      const key = decodeURIComponent(m[2]);
      if (c.method === "GET") {
        const d = store.get(key);
        return d ? { body: d } : { status: 404, body: { error: "not found" } };
      }
      if (c.method === "PUT") {
        const { body, if_not_exists } = c.body as { body: Record<string, unknown>; if_not_exists?: boolean };
        const prev = store.get(key);
        if (prev && if_not_exists) return { status: 409, body: { error: "exists" } };
        const doc: Doc = { key, body, created_at: prev?.created_at ?? 1, updated_at: 2, version: (prev?.version ?? 0) + 1 };
        store.set(key, doc);
        return { body: doc };
      }
    }
    return { status: 404, body: { error: `no route ${c.method} ${c.path}` } };
  };

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? "GET",
      path: String(input).replace("https://anvil.test", ""),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.get("authorization"),
    };
    calls.push(call);
    const reply = handle(call);
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const roles = coll("app_devforge.roles");
  const roleBySlug = (slug: string) => [...roles.values()].find((d) => d.body.slug === slug);
  return { calls, roles, roleBySlug, accounts: coll("app_devforge.accounts") };
}

const ben: User = { id: "u-ben", email: "Ben@Example.com", username: "ben", last_signed_in_on: 3000 };
const ann: User = { id: "u-ann", email: "ann@example.com", username: "ann", last_signed_in_on: 2000 };
const dee: User = { id: "u-dee", email: "dee@example.com", username: "dee", last_signed_in_on: 1000 };

/** UUID of the role with this slug, as seeded in the fake. */
async function idOf(slug: string): Promise<string> {
  const role = await getRoleBySlug(slug);
  assert.ok(role, `role ${slug} exists`);
  return role.id;
}

beforeEach(() => {
  resetAccountsCache();
  resetAccountAppCache();
  delete process.env.ACCOUNT_ADMINS;
  globalThis.fetch = realFetch;
  console.error = realError;
});

test("ACCOUNT_ADMINS is a loose list of lower-cased addresses", () => {
  assert.deepEqual([...configuredAdmins()], []);
  process.env.ACCOUNT_ADMINS = " Ben@Example.com, ann@example.com;  cy@example.com\n";
  assert.deepEqual([...configuredAdmins()].sort(), ["ann@example.com", "ben@example.com", "cy@example.com"]);
  assert.equal(effectiveRole(null, "BEN@example.com"), "admin");
  assert.equal(effectiveRole("member", "ann@example.com"), "admin");
  assert.equal(effectiveRole("client", "dee@example.com"), "client");
  assert.equal(effectiveRole(null, "dee@example.com"), "member");
});

test("first use creates both collections and seeds the built-in roles under fresh UUIDs, once", async () => {
  const { calls, roles, roleBySlug } = anvil();
  const list = await listRoles();
  assert.deepEqual(
    list.map((r) => r.slug),
    ["admin", "client", "member"],
  );
  assert.ok(list.every((r) => r.builtin && isRoleId(r.id)));
  assert.equal(new Set(list.map((r) => r.id)).size, 3, "distinct ids");
  for (const r of list) {
    const doc = roles.get(r.id)!;
    assert.equal(doc.body.id, r.id);
    assert.equal(doc.body.slug, r.slug);
    assert.equal(doc.body.created_by, "seed");
  }
  assert.deepEqual(
    calls.filter((c) => c.method === "POST" && !c.path.endsWith("/query")).map((c) => c.path),
    ["/docs/app_devforge.roles", "/docs/app_devforge.accounts"],
  );
  const seedPuts = () => calls.filter((c) => c.method === "PUT" && c.path.startsWith("/docs/app_devforge.roles/")).length;
  assert.equal(seedPuts(), 3);
  await listRoles();
  assert.equal(seedPuts(), 3, "seeding and listing are cached");
  // a later process finds the rows by slug and leaves them alone, ids included
  resetAccountsCache();
  roleBySlug("client")!.body.description = "Edited by hand";
  const again = await listRoles();
  assert.equal(seedPuts(), 3);
  assert.deepEqual(
    again.map((r) => r.id),
    list.map((r) => r.id),
  );
  assert.equal((await getRoleBySlug("client"))?.description, "Edited by hand");
  assert.deepEqual(await getRole(list[0].id), list[0]);
  assert.equal(await getRole("admin"), null, "slugs are not ids");
  assert.equal(await getRoleBySlug("nope"), null);
  // rows without a slug or with a non-UUID key are ignored
  roles.set("admin", { key: "admin", body: { id: "admin", name: "Old" }, created_at: 0, updated_at: 0, version: 1 });
  resetAccountsCache();
  assert.equal((await listRoles()).length, 3);
});

test("concurrent first loads share one seed, and a duplicate slug resolves to the oldest row", async () => {
  const { calls, roles } = anvil();
  const [a, b] = await Promise.all([listRoles(), listRoles()]);
  assert.deepEqual(a, b);
  assert.equal(calls.filter((c) => c.method === "PUT").length, 3);
  // another instance seeded its own admin row a little later
  roles.set("11111111-1111-4111-8111-111111111111", {
    key: "11111111-1111-4111-8111-111111111111",
    body: { id: "11111111-1111-4111-8111-111111111111", slug: "admin", name: "Admin", builtin: true, created_at: Date.now() + 10_000 },
    created_at: 9,
    updated_at: 9,
    version: 1,
  });
  resetAccountsCache();
  const list = await listRoles();
  assert.equal(list.filter((r) => r.slug === "admin").length, 1);
  assert.equal(list.find((r) => r.slug === "admin")?.id, a.find((r) => r.slug === "admin")?.id);
});

test("sign-in reads the role without writing anything", async () => {
  const { calls, accounts } = anvil([ann]);
  assert.equal(await roleForSignIn({ sub: "u-ann", email: "ann@example.com" }), "member");
  assert.equal(accounts.size, 0);
  assert.ok(!calls.some((c) => c.method === "PUT" && c.path.startsWith("/docs/app_devforge.accounts/")));
  process.env.ACCOUNT_ADMINS = "ben@example.com";
  assert.equal(await roleForSignIn({ sub: "u-ben", email: "Ben@Example.com" }), "admin");
  assert.equal(accounts.size, 0);
});

test("Anvil trouble at sign-in is logged, never thrown, and the environment still decides", async () => {
  const logged: string[] = [];
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "down" }), { status: 503 })) as typeof fetch;
  assert.equal(await roleForSignIn({ sub: "u-ann", email: "ann@example.com" }), "member");
  process.env.ACCOUNT_ADMINS = "ben@example.com";
  assert.equal(await roleForSignIn({ sub: "u-ben", email: "ben@example.com" }), "admin");
  assert.match(logged.join("\n"), /could not read the role of u-ann at sign-in/);
  await assert.rejects(getAccountRole("u-ann", "ann@example.com"));
  assert.deepEqual(await describeRole("client"), { id: "", slug: "client", name: "Client", description: "A Devforge client. Gets the client-only areas of the site.", builtin: true });
  assert.deepEqual(await describeRole("partner"), { id: "", slug: "partner", name: "partner", description: "", builtin: false });
});

test("setAccountRole writes only the link to the role's UUID, and the role must exist", async () => {
  const { accounts } = anvil([ann]);
  const client = await idOf("client");
  const rec = await setAccountRole("u-ann", client, "u-ben");
  assert.equal(rec.roleId, client);
  assert.equal(rec.setBy, "u-ben");
  const body = accounts.get("u-ann")!.body;
  assert.deepEqual(Object.keys(body).sort(), ["created_at", "role_id", "set_at", "set_by", "updated_at", "user_id"]);
  assert.equal(body.role_id, client);
  assert.equal(body.user_id, "u-ann");
  assert.ok(!("email" in body) && !("username" in body) && !("slug" in body));
  // replacing keeps created_at
  await new Promise((r) => setTimeout(r, 2));
  const again = await setAccountRole("u-ann", await idOf("admin"), "u-ben");
  assert.equal(again.createdAt, rec.createdAt);
  assert.ok(again.setAt > rec.setAt);
  await assert.rejects(setAccountRole("u-ann", "client", "u-ben"), /No role with id "client"/);
  await assert.rejects(setAccountRole("u-ann", "22222222-2222-4222-8222-222222222222", "u-ben"), /No role with id/);
  await assert.rejects(setAccountRole("bad id!", client, "u-ben"), /Invalid user id/);
  assert.equal(await getAccountRecord("u-nobody"), null);
});

test("getAccountRole resolves the UUID to a slug, caches for a minute, and a vanished role reads as member", async () => {
  const { calls, roles } = anvil([ann]);
  const reads = () => calls.filter((c) => c.method === "GET" && c.path === "/docs/app_devforge.accounts/u-ann").length;
  assert.equal(await getAccountRole("u-ann", "ann@example.com"), "member");
  assert.equal(await getAccountRole("u-ann", "ann@example.com"), "member");
  assert.equal(reads(), 1);
  await setAccountRole("u-ann", await idOf("client"), "u-ben");
  assert.equal(await getAccountRole("u-ann", "ann@example.com"), "client");
  assert.equal(reads(), 3, "one read inside the change, one after it");
  // an admin listed in the environment never touches the store
  process.env.ACCOUNT_ADMINS = "ann@example.com";
  resetAccountsCache();
  assert.equal(await getAccountRole("u-ann", "ann@example.com"), "admin");
  assert.equal(reads(), 3);
  delete process.env.ACCOUNT_ADMINS;
  // a custom role whose row disappears reads as member (built-ins are reseeded, so they cannot vanish)
  const partner = (await createRole({ name: "Partner", description: "" }, "u-ben")).role!;
  await setAccountRole("u-ann", partner.id, "u-ben");
  assert.equal(await getAccountRole("u-ann", "ann@example.com"), "partner");
  roles.delete(partner.id);
  resetAccountsCache();
  assert.equal(await getAccountRole("u-ann", "ann@example.com"), "member");
  const clientId = await idOf("client");
  roles.delete(clientId);
  resetAccountsCache();
  const reseeded = await getRoleBySlug("client");
  assert.ok(reseeded && reseeded.id !== clientId, "a deleted built-in comes back under a new id");
});

test("assignRoleByEmail finds the Anvil user and reports strangers", async () => {
  const { accounts } = anvil([ann, dee]);
  const client = await idOf("client");
  let res = await assignRoleByEmail("ANN@example.com", client, "u-ben");
  assert.equal(res.outcome, "updated");
  assert.equal(res.record?.userId, "u-ann");
  assert.equal(accounts.get("u-ann")!.body.role_id, client);
  res = await assignRoleByEmail("ann@example.com", client, "u-ben");
  assert.equal(res.outcome, "unchanged");
  res = await assignRoleByEmail("nobody@example.com", client, "u-ben");
  assert.equal(res.outcome, "no_account");
  res = await assignRoleByEmail("   ", client, "u-ben");
  assert.equal(res.outcome, "no_account");
  assert.equal(accounts.size, 1);
});

test("createRole adds a UUID row admins can assign, with a slug from the name", async () => {
  const { roles } = anvil([ann]);
  let res = await createRole({ name: "  Partner   agency ", description: "Agencies we build with." }, "u-ben");
  assert.equal(res.outcome, "created");
  assert.ok(isRoleId(res.role!.id));
  assert.deepEqual({ ...res.role, id: "x" }, { id: "x", slug: "partner-agency", name: "Partner agency", description: "Agencies we build with.", builtin: false });
  assert.equal(roles.get(res.role!.id)!.body.created_by, "u-ben");
  assert.deepEqual(
    (await listRoles()).map((r) => r.slug),
    ["admin", "client", "member", "partner-agency"],
  );
  assert.equal((await setAccountRole("u-ann", res.role!.id, "u-ben")).roleId, res.role!.id);
  assert.equal(await getAccountRole("u-ann", "ann@example.com"), "partner-agency");

  const first = res.role!.id;
  res = await createRole({ name: "Partner Agency", description: "" }, "u-ben");
  assert.equal(res.outcome, "exists");
  assert.equal(res.role?.id, first);
  res = await createRole({ name: "Admin", description: "" }, "u-ben");
  assert.equal(res.outcome, "exists");
  res = await createRole({ name: "x", description: "" }, "u-ben");
  assert.equal(res.outcome, "invalid");
  res = await createRole({ name: "!!!", description: "" }, "u-ben");
  assert.equal(res.outcome, "invalid");
  res = await createRole({ name: "Fine", description: "d".repeat(201) }, "u-ben");
  assert.equal(res.outcome, "invalid");
});

test("listPeople joins app members and assigned roles with auth.users", async () => {
  process.env.ACCOUNT_ADMINS = "ben@example.com";
  const stranger: User = { id: "u-out", email: "out@example.com", username: "out", last_signed_in_on: 9000 };
  anvil([ben, ann, dee, stranger], ["u-ben", "u-ann"]);
  const client = await idOf("client");
  await setAccountRole("u-dee", client, "u-ben");
  const people = await listPeople();
  assert.deepEqual(
    people.map((p) => [p.id, p.email, p.role, p.assigned, p.pinned]),
    [
      ["u-ben", "ben@example.com", "admin", false, true],
      ["u-ann", "ann@example.com", "member", false, false],
      ["u-dee", "dee@example.com", "client", true, false],
    ],
    "members and role holders, most recent sign-in first; non-members without a role are left out",
  );
  assert.equal(people[0].roleId, await idOf("admin"));
  assert.equal(people[1].roleId, await idOf("member"));
  assert.equal(people[2].roleId, client);
  assert.equal(people[0].username, "ben");
  assert.equal(people[0].lastSignedInAt, 3000);
});
