import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { accountSignInHeaders, getAccountUser, requireAccountRole, requireAccountUser } from "./session.server";
import { resetAccountsCache } from "./accounts.server";

process.env.SESSION_SECRET = "unit-test-secret";
process.env.ANVIL_URL = "https://anvil.test";
process.env.ANVIL_SERVICE_KEY = "test-key";

const realFetch = globalThis.fetch;
const realError = console.error;

const identity = { sub: "u-ann", username: "ann", email: "ann@example.com", roles: ["user"] };
const tokens = { accessToken: "a.b.c", refreshToken: "rt" };

async function requestWith(headers: Headers, path = "/account/people"): Promise<Request> {
  const cookie = headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c) => !c.endsWith("="))
    .join("; ");
  return new Request(`https://devforge.io${path}`, { headers: { Cookie: cookie } });
}

/** A fake Anvil with the seeded roles and, when `roleId` is set, one accounts row for Ann. */
function store(roleId: string | null, status = 200) {
  const roles = ["admin", "client", "member"].map((id) => ({ key: id, body: { id, name: id, description: "", builtin: true }, created_at: 1, updated_at: 1, version: 1 }));
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace("https://anvil.test", "");
    if (status !== 200) return new Response(JSON.stringify({ error: "down" }), { status });
    if (init?.method === "POST" && /^\/docs\/app_devforge\.(roles|accounts)$/.test(path)) return Response.json({});
    if (init?.method === "PUT" && path.startsWith("/docs/app_devforge.roles/")) return new Response(JSON.stringify({ error: "exists" }), { status: 409 });
    if (init?.method === "POST" && path === "/docs/app_devforge.roles/query") return Response.json({ documents: roles });
    if (path === "/docs/app_devforge.accounts/u-ann" && roleId) {
      return Response.json({ key: "u-ann", body: { user_id: "u-ann", role_id: roleId }, created_at: 1, updated_at: 1, version: 1 });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }) as typeof fetch;
}

beforeEach(() => {
  resetAccountsCache();
  delete process.env.ACCOUNT_ADMINS;
  globalThis.fetch = realFetch;
  console.error = realError;
});

test("the cookie carries the role id; a cookie without one reads as member", async () => {
  const user = await getAccountUser(await requestWith(await accountSignInHeaders(identity, tokens, "client")));
  assert.equal(user?.id, "u-ann");
  assert.equal(user?.email, "ann@example.com");
  assert.equal(user?.role, "client");
  const plain = await getAccountUser(await requestWith(await accountSignInHeaders(identity, tokens)));
  assert.equal(plain?.role, "member");
  const custom = await getAccountUser(await requestWith(await accountSignInHeaders(identity, tokens, "partner-agency")));
  assert.equal(custom?.role, "partner-agency");
  assert.equal(await getAccountUser(new Request("https://devforge.io/account")), null);
});

test("requireAccountUser sends strangers to sign in with a return path", async () => {
  await assert.rejects(requireAccountUser(new Request("https://devforge.io/account/people?x=1")), (res: Response) => {
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("Location"), "/account/sign-in?next=%2Faccount%2Fpeople%3Fx%3D1");
    return true;
  });
});

test("requireAccountRole checks the assigned role, not the cookie's snapshot", async () => {
  const asClientCookie = await requestWith(await accountSignInHeaders(identity, tokens, "client"));
  store(null);
  await assert.rejects(requireAccountRole(asClientCookie, ["client"]), (res: Response) => {
    assert.equal(res.status, 403);
    assert.match(res.statusText, /client role/);
    return true;
  });
  resetAccountsCache();
  store("admin");
  const admin = await requireAccountRole(asClientCookie, ["client"]);
  assert.equal(admin.role, "admin");
  resetAccountsCache();
  store("client");
  await assert.rejects(requireAccountRole(asClientCookie, ["admin"]), (res: Response) => res.status === 403);
  assert.equal((await requireAccountRole(asClientCookie, ["client"])).role, "client");
});

test("ACCOUNT_ADMINS wins without touching the store, and a store outage falls back to the cookie", async () => {
  const logged: string[] = [];
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  process.env.ACCOUNT_ADMINS = "ann@example.com";
  store(null, 503);
  const me = await requireAccountRole(await requestWith(await accountSignInHeaders(identity, tokens)), ["admin"]);
  assert.equal(me.role, "admin");
  delete process.env.ACCOUNT_ADMINS;
  const fallback = await requireAccountRole(await requestWith(await accountSignInHeaders(identity, tokens, "client")), ["client"]);
  assert.equal(fallback.role, "client");
  assert.match(logged.join("\n"), /could not read the role of u-ann/);
  await assert.rejects(requireAccountRole(await requestWith(await accountSignInHeaders(identity, tokens)), ["client"]), (res: Response) => res.status === 403);
});
