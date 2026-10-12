import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ROLE, BUILTIN_ROLES, DEFAULT_ROLE, isRoleId, isRoleSlug, roleAllows, roleSlugFromName } from "./roles";

test("three built-in roles, member by default, admin on top", () => {
  assert.deepEqual(
    BUILTIN_ROLES.map((r) => r.slug),
    ["admin", "client", "member"],
  );
  assert.ok(BUILTIN_ROLES.every((r) => r.builtin && r.name && r.description));
  assert.equal(DEFAULT_ROLE, "member");
  assert.equal(ADMIN_ROLE, "admin");
});

test("role slugs are short lower-case names, role ids are UUIDs", () => {
  assert.ok(isRoleSlug("admin"));
  assert.ok(isRoleSlug("partner-agency"));
  assert.ok(isRoleSlug("tier_2"));
  assert.ok(!isRoleSlug("Admin"));
  assert.ok(!isRoleSlug("2fa"));
  assert.ok(!isRoleSlug(""));
  assert.ok(!isRoleSlug("a".repeat(33)));
  assert.ok(!isRoleSlug(undefined));
  assert.ok(isRoleId("f678da77-eb48-4f4c-9cad-c2f412f36bfa"));
  assert.ok(isRoleId("F678DA77-EB48-4F4C-9CAD-C2F412F36BFA"));
  assert.ok(!isRoleId("admin"));
  assert.ok(!isRoleId("f678da77eb484f4c9cadc2f412f36bfa"));
  assert.ok(!isRoleId(""));
  assert.ok(!isRoleId(null));
});

test("a slug is made from the display name", () => {
  assert.equal(roleSlugFromName("Partner agency"), "partner-agency");
  assert.equal(roleSlugFromName("  Client  "), "client");
  assert.equal(roleSlugFromName("VIP (2026)"), "vip-2026");
  assert.equal(roleSlugFromName("2nd tier"), "nd-tier");
  assert.equal(roleSlugFromName("!!!"), null);
  assert.equal(roleSlugFromName("x".repeat(50))?.length, 32);
});

test("admins pass every check, others need their role listed", () => {
  assert.ok(roleAllows("admin", ["client"]));
  assert.ok(roleAllows("admin", []));
  assert.ok(roleAllows("client", ["client", "member"]));
  assert.ok(!roleAllows("client", ["admin"]));
  assert.ok(!roleAllows("member", ["client"]));
  assert.ok(roleAllows("partner-agency", ["partner-agency"]));
});
