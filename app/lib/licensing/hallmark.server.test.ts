import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { HallmarkError, dropActivation, hallmarkConfigured, issueLicense, revokeLicense, showLicense, verifyLicenseKey } from "./hallmark.server";

process.env.HALLMARK_URL = "https://hallmark.test";
process.env.HALLMARK_ADMIN_TOKEN = "admin-test";

type Call = { method: string; path: string; body?: unknown; auth: string | null };
type Reply = { status?: number; body?: unknown };

const realFetch = globalThis.fetch;

function stubFetch(handler: (call: Call) => Reply): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? "GET",
      path: String(input).replace("https://hallmark.test", ""),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.get("authorization"),
    };
    calls.push(call);
    const reply = handler(call);
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

beforeEach(() => {
  globalThis.fetch = realFetch;
  process.env.HALLMARK_ADMIN_TOKEN = "admin-test";
});

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A throwaway hallmark: Ed25519 keypair, public half as hallmark publishes it, and a signer. */
function fakeHallmark() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const publicB64 = b64url(spki.subarray(spki.length - 32));
  const signKey = (payload: object, prefix = "HMR") => {
    const json = Buffer.from(JSON.stringify(payload));
    return `${prefix}-${b64url(json)}.${b64url(sign(null, json, privateKey))}`;
  };
  return { publicB64, signKey };
}

test("issueLicense posts the admin request and returns the record with its key", async () => {
  const calls = stubFetch((c) => {
    if (c.method === "POST" && c.path === "/v1/admin/licenses") {
      return { status: 201, body: { id: "lic_0123456789ab", key: "HMR-abc.def", v: 1, product: "hammer", licensee: "ben", email: "ben@example.com", issued: 1_700_000_000, seats: 1, revoked: false, note: "stripe sub_1" } };
    }
    return { status: 404, body: { error: "no route" } };
  });
  const rec = await issueLicense({ product: "hammer", licensee: "ben", email: "ben@example.com", seats: 1, note: "stripe sub_1" });
  assert.equal(rec.id, "lic_0123456789ab");
  assert.equal(rec.key, "HMR-abc.def");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].auth, "Bearer admin-test");
  assert.deepEqual(calls[0].body, { licensee: "ben", product: "hammer", email: "ben@example.com", seats: 1, note: "stripe sub_1" });
});

test("show, revoke and drop-activation hit the right paths; an unknown licence shows as null", async () => {
  const calls = stubFetch((c) => {
    if (c.method === "GET" && c.path === "/v1/admin/licenses/lic_known") {
      return { body: { license: { id: "lic_known", key: "HMR-x.y", revoked: false }, seats_used: 1, activations: { "mac-1": { first_seen: 1, last_seen: 2, app_version: "0.21.66" } } } };
    }
    if (c.method === "GET" && c.path === "/v1/admin/licenses/lic_gone") return { status: 404, body: { error: "no such licence" } };
    if (c.method === "POST" && c.path === "/v1/admin/licenses/lic_known/revoke") return { body: { id: "lic_known", revoked: true, revoked_at: 3 } };
    if (c.method === "DELETE" && c.path === "/v1/admin/licenses/lic_known/activations/mac-1%2Fhome") return { body: { removed: true, seats_used: 0 } };
    return { status: 404, body: { error: `no route ${c.method} ${c.path}` } };
  });
  const shown = await showLicense("lic_known");
  assert.equal(shown?.seats_used, 1);
  assert.deepEqual(Object.keys(shown?.activations ?? {}), ["mac-1"]);
  assert.equal(await showLicense("lic_gone"), null);
  assert.equal((await revokeLicense("lic_known")).revoked, true);
  assert.deepEqual(await dropActivation("lic_known", "mac-1/home"), { removed: true, seats_used: 0 });
  await assert.rejects(dropActivation("lic_known", "x".repeat(200)), /machine id/);
  await assert.rejects(dropActivation("lic_known", "mac 1"), /machine id/, "hallmark allows printable ASCII only, no spaces");
  await assert.rejects(dropActivation("../admin", "mac"), /licence id/);
  assert.equal(calls.length, 4);
});

test("a missing admin token and an unreachable service surface as 503s", async () => {
  process.env.HALLMARK_ADMIN_TOKEN = "";
  assert.equal(hallmarkConfigured(), false);
  await assert.rejects(issueLicense({ licensee: "x" }), (e: unknown) => e instanceof HallmarkError && e.status === 503);
  process.env.HALLMARK_ADMIN_TOKEN = "admin-test";
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  await assert.rejects(issueLicense({ licensee: "x" }), (e: unknown) => e instanceof HallmarkError && e.status === 503 && /unreachable/.test(e.message));
});

test("verifyLicenseKey accepts a key signed by the service and rejects everything else", () => {
  const hm = fakeHallmark();
  const payload = { v: 1, id: "lic_abcdef012345", product: "hammer", licensee: "ben", email: "ben@example.com", issued: 1_700_000_000, seats: 1 };
  const key = hm.signKey(payload);
  assert.deepEqual(verifyLicenseKey(key, hm.publicB64), payload);
  assert.deepEqual(verifyLicenseKey(`  ${key}\n`, hm.publicB64), payload);

  const other = fakeHallmark();
  assert.throws(() => verifyLicenseKey(key, other.publicB64), /does not match/);
  assert.throws(() => verifyLicenseKey(hm.signKey(payload, "VRD"), hm.publicB64), /Not a Hammer licence key/);
  const [head, sig] = key.split(".");
  const forged = `${head.slice(0, -2)}AA.${sig}`;
  assert.throws(() => verifyLicenseKey(forged, hm.publicB64), /does not match|base64|malformed/);
  assert.throws(() => verifyLicenseKey("HMR-abc", hm.publicB64), /no signature/);
  assert.throws(() => verifyLicenseKey(key, ""), /HALLMARK_PUBLIC_KEY/);
});
