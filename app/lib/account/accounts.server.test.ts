import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  assignRoleByEmail,
  configuredAdmins,
  effectiveRole,
  getAccountRecord,
  getAccountRole,
  listAccounts,
  recordSignIn,
  resetAccountsCache,
  setAccountRole,
} from "./accounts.server";

process.env.ANVIL_URL = "https://anvil.test";
process.env.ANVIL_SERVICE_KEY = "test-key";

type Call = { method: string; path: string; body?: unknown; auth: string | null };
type Reply = { status?: number; body?: unknown };
type Doc = { key: string; body: Record<string, unknown>; created_at: number; updated_at: number; version: number };

const realFetch = globalThis.fetch;
const realError = console.error;

/**
 * A fake Anvil with a document store for app_devforge.accounts and a read-only
 * auth.users table (what lookupUserIdByEmail scans).
 */
function anvil(users: { id: string; email: string }[] = []) {
  const accounts = new Map<string, Doc>();
  const calls: Call[] = [];
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

  const handle = (c: Call): Reply => {
    assert.equal(c.auth, "Bearer test-key");
    if (c.method === "POST" && c.path === "/docs/app_devforge.accounts") return { body: { created: true } };
    if (c.method === "POST" && c.path === "/docs/app_devforge.accounts/query") {
      const filter = (c.body as { filter?: { op: string; field: string; value: unknown } }).filter;
      const docs = [...accounts.values()].filter((d) => !filter || (filter.op === "eq" && d.body[filter.field] === filter.value));
      return { body: { documents: docs } };
    }
    if (c.method === "POST" && c.path === "/docs/auth.users/query") {
      return { body: { documents: users.map((u) => ({ key: u.id, body: { id: u.id, email: u.email }, created_at: 0, updated_at: 0, version: 1 })) } };
    }
    const m = c.path.match(/^\/docs\/app_devforge\.accounts\/([^/]+)$/);
    if (m) {
      const key = decodeURIComponent(m[1]);
      if (c.method === "GET") {
        const d = accounts.get(key);
        return d ? { body: d } : { status: 404, body: { error: "not found" } };
      }
      if (c.method === "PUT") {
        const body = (c.body as { body: Record<string, unknown> }).body;
        const prev = accounts.get(key);
        const doc: Doc = { key, body, created_at: prev?.created_at ?? 1, updated_at: 2, version: (prev?.version ?? 0) + 1 };
        accounts.set(key, doc);
        return { body: doc };
      }
    }
    return { status: 404, body: { error: `no route ${c.method} ${c.path}` } };
  };
  return { accounts, calls };
}

beforeEach(() => {
  resetAccountsCache();
  delete process.env.ACCOUNT_ADMINS;
  globalThis.fetch = realFetch;
  console.error = realError;
});

const ben = { sub: "u-ben", email: "Ben@Example.com", username: "ben" };
const ann = { sub: "u-ann", email: "ann@example.com", username: "ann" };

test("ACCOUNT_ADMINS is a loose list of lower-cased addresses", () => {
  assert.deepEqual([...configuredAdmins()], []);
  process.env.ACCOUNT_ADMINS = " Ben@Example.com, ann@example.com;  cy@example.com\n";
  assert.deepEqual([...configuredAdmins()].sort(), ["ann@example.com", "ben@example.com", "cy@example.com"]);
  assert.equal(effectiveRole(null, "BEN@example.com"), "admin");
  assert.equal(effectiveRole({ role: "member", email: "ann@example.com" }), "admin");
  assert.equal(effectiveRole({ role: "client", email: "dee@example.com" }), "client");
  assert.equal(effectiveRole(null, "dee@example.com"), "member");
});

test("a first sign-in creates a member record; later sign-ins keep the role and bump lastSignInAt", async () => {
  const { accounts, calls } = anvil();
  assert.equal(await recordSignIn(ann), "member");
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    ["POST /docs/app_devforge.accounts", "GET /docs/app_devforge.accounts/u-ann", "PUT /docs/app_devforge.accounts/u-ann"],
  );
  const first = accounts.get("u-ann")!.body;
  assert.equal(first.role, "member");
  assert.equal(first.email, "ann@example.com");
  assert.equal(first.username, "ann");
  assert.ok(typeof first.createdAt === "number" && first.createdAt > 0);

  await setAccountRole("u-ann", "client", "u-ben");
  const before = (accounts.get("u-ann")!.body as { lastSignInAt: number }).lastSignInAt;
  await new Promise((r) => setTimeout(r, 2));
  assert.equal(await recordSignIn({ ...ann, username: "ann2" }), "client");
  const again = accounts.get("u-ann")!.body;
  assert.equal(again.role, "client");
  assert.equal(again.username, "ann2");
  assert.ok((again.lastSignInAt as number) > before);
  assert.equal(again.createdAt, first.createdAt);
  // the collection is only created once per process
  assert.equal(calls.filter((c) => c.method === "POST" && c.path === "/docs/app_devforge.accounts").length, 1);
});

test("an address in ACCOUNT_ADMINS is stored and reported as admin", async () => {
  process.env.ACCOUNT_ADMINS = "ben@example.com";
  const { accounts } = anvil();
  assert.equal(await recordSignIn(ben), "admin");
  assert.equal(accounts.get("u-ben")!.body.role, "admin");
  assert.equal(accounts.get("u-ben")!.body.email, "ben@example.com");
  // demoting a listed admin changes the record, not the effective role
  await setAccountRole("u-ben", "member", "u-ann");
  assert.equal(accounts.get("u-ben")!.body.role, "member");
  assert.equal(await getAccountRole("u-ben", "ben@example.com"), "admin");
});

test("Anvil trouble is logged, never thrown, and the environment still decides", async () => {
  const logged: string[] = [];
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "down" }), { status: 503 })) as typeof fetch;
  assert.equal(await recordSignIn(ann), "member");
  process.env.ACCOUNT_ADMINS = "ben@example.com";
  assert.equal(await recordSignIn(ben), "admin");
  assert.match(logged.join("\n"), /could not record sign-in for u-ann/);
  await assert.rejects(getAccountRole("u-ann", "ann@example.com"));
});

test("getAccountRole caches for a minute and a role change clears it", async () => {
  const { calls } = anvil();
  await recordSignIn(ann);
  const reads = () => calls.filter((c) => c.method === "GET").length;
  const n = reads();
  assert.equal(await getAccountRole("u-ann", "ann@example.com"), "member");
  assert.equal(await getAccountRole("u-ann", "ann@example.com"), "member");
  assert.equal(reads(), n, "served from the sign-in cache");
  await setAccountRole("u-ann", "client", "u-ben");
  assert.equal(await getAccountRole("u-ann", "ann@example.com"), "client");
  assert.equal(reads(), n + 2, "one read for the change, one after it");
  assert.equal(await getAccountRole("u-ann", "ann@example.com"), "client");
  assert.equal(reads(), n + 2);
  // unknown people are members
  assert.equal(await getAccountRole("u-nobody", "nobody@example.com"), "member");
  assert.equal(await setAccountRole("u-nobody", "client", "u-ben"), null);
  await assert.rejects(setAccountRole("bad id!", "client", "u-ben"), /Invalid user id/);
});

test("listAccounts puts the most recent sign-in first", async () => {
  anvil();
  await recordSignIn(ben);
  await new Promise((r) => setTimeout(r, 2));
  await recordSignIn(ann);
  const list = await listAccounts();
  assert.deepEqual(
    list.map((a) => a.email),
    ["ann@example.com", "ben@example.com"],
  );
  assert.equal((await getAccountRecord("u-ben"))?.username, "ben");
  assert.equal(await getAccountRecord("not a valid id"), null);
});

test("assignRoleByEmail updates a record, creates one for a known Anvil user, and reports strangers", async () => {
  const { accounts } = anvil([{ id: "u-dee", email: "Dee@Example.com" }]);
  await recordSignIn(ann);

  let res = await assignRoleByEmail("ANN@example.com", "client", "u-ben");
  assert.equal(res.outcome, "updated");
  assert.equal(res.record?.role, "client");
  assert.equal(res.record?.roleSetBy, "u-ben");
  assert.equal(await getAccountRole("u-ann", "ann@example.com"), "client");

  res = await assignRoleByEmail("ann@example.com", "client", "u-ben");
  assert.equal(res.outcome, "unchanged");

  res = await assignRoleByEmail("dee@example.com", "admin", "u-ben");
  assert.equal(res.outcome, "created");
  assert.equal(res.record?.id, "u-dee");
  assert.equal(res.record?.lastSignInAt, 0);
  assert.equal(accounts.get("u-dee")!.body.role, "admin");
  assert.equal(await getAccountRole("u-dee", "dee@example.com"), "admin");
  // when Dee signs in, the record is kept and completed
  assert.equal(await recordSignIn({ sub: "u-dee", email: "dee@example.com", username: "dee" }), "admin");
  assert.equal(accounts.get("u-dee")!.body.username, "dee");
  assert.ok((accounts.get("u-dee")!.body.lastSignInAt as number) > 0);

  res = await assignRoleByEmail("nobody@example.com", "client", "u-ben");
  assert.equal(res.outcome, "no_account");
  res = await assignRoleByEmail("   ", "client", "u-ben");
  assert.equal(res.outcome, "no_account");
});
