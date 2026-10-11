import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ACCOUNT_APP, accountAppSlug, ensureAccountMember, resetAccountAppCache } from "./anvil-app.server";

process.env.ANVIL_URL = "https://anvil.test";
process.env.ANVIL_SERVICE_KEY = "test-key";

const APP_ID = "f678da77-eb48-4f4c-9cad-c2f412f36bfa";

type Call = { method: string; path: string; body?: unknown; auth: string | null };
type Reply = { status?: number; body?: unknown };

const realFetch = globalThis.fetch;
const realError = console.error;

function stubFetch(handler: (call: Call) => Reply): Call[] {
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
    const reply = handler(call);
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

/** A fake Anvil where `members` already belong to the devforge app. */
function anvil(members: string[]) {
  return (call: Call): Reply => {
    if (call.method === "GET" && call.path === "/apps/devforge") return { body: { id: APP_ID, slug: "devforge" } };
    if (call.method === "POST" && call.path === "/docs/auth.app_members/query") {
      const filter = (call.body as { filter: { conditions: { field: string; value: string }[] } }).filter;
      const user = filter.conditions.find((c) => c.field === "user_id")?.value ?? "";
      const app = filter.conditions.find((c) => c.field === "app_id")?.value;
      assert.equal(app, APP_ID);
      return { body: { documents: members.includes(user) ? [{ key: `${APP_ID}:${user}`, body: { privilege: "admin" } }] : [] } };
    }
    if (call.method === "PUT" && call.path.startsWith("/apps/devforge/members/")) return { body: { app_id: APP_ID } };
    return { status: 404, body: { error: `no route ${call.method} ${call.path}` } };
  };
}

beforeEach(() => {
  resetAccountAppCache();
  delete process.env.ANVIL_APP;
  globalThis.fetch = realFetch;
  console.error = realError;
});

test("accountAppSlug defaults to devforge and accepts an override", () => {
  assert.equal(accountAppSlug(), DEFAULT_ACCOUNT_APP);
  process.env.ANVIL_APP = "  timetopie ";
  assert.equal(accountAppSlug(), "timetopie");
  process.env.ANVIL_APP = "Bad Slug";
  assert.throws(() => accountAppSlug(), /ANVIL_APP/);
});

test("a first sign-in enrols the person as a reader, later ones are free", async () => {
  const calls = stubFetch(anvil([]));
  assert.equal(await ensureAccountMember("u1"), "enrolled");
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    ["GET /apps/devforge", "POST /docs/auth.app_members/query", "PUT /apps/devforge/members/u1"],
  );
  assert.deepEqual(calls[2].body, { privilege: "reader" });
  assert.ok(calls.every((c) => c.auth === "Bearer test-key"));
  assert.equal(await ensureAccountMember("u1"), "existing");
  assert.equal(calls.length, 3);
});

test("an existing member is left alone, whatever their privilege", async () => {
  const calls = stubFetch(anvil(["admin-user"]));
  assert.equal(await ensureAccountMember("admin-user"), "existing");
  assert.ok(!calls.some((c) => c.method === "PUT"));
  assert.equal(await ensureAccountMember("u2"), "enrolled");
  // the app id was cached by the first call
  assert.equal(calls.filter((c) => c.path === "/apps/devforge").length, 1);
});

test("a fresh account skips the lookup", async () => {
  const calls = stubFetch(anvil([]));
  assert.equal(await ensureAccountMember("new-user", { fresh: true }), "enrolled");
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    ["PUT /apps/devforge/members/new-user"],
  );
});

test("Anvil trouble is reported, not thrown, and retried next time", async () => {
  const logged: string[] = [];
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  let broken = true;
  const calls = stubFetch((call) => (broken ? { status: 503, body: { error: "down" } } : anvil([])(call)));
  assert.equal(await ensureAccountMember("u3"), "failed");
  assert.ok(!calls.some((c) => c.method === "PUT"));
  assert.match(logged.join("\n"), /could not enrol user u3/);
  broken = false;
  assert.equal(await ensureAccountMember("u3"), "enrolled");
  assert.equal(await ensureAccountMember(""), "failed");
});
