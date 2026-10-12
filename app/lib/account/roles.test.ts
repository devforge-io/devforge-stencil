import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ROLE, BUILTIN_ROLES, DEFAULT_ROLE, isRoleId, roleAllows, roleIdFromName } from "./roles";

test("three built-in roles, member by default, admin on top", () => {
  assert.deepEqual(
    BUILTIN_ROLES.map((r) => r.id),
    ["admin", "client", "member"],
  );
  assert.ok(BUILTIN_ROLES.every((r) => r.builtin && r.name && r.description));
  assert.equal(DEFAULT_ROLE, "member");
  assert.equal(ADMIN_ROLE, "admin");
});

test("role ids are short lower-case slugs", () => {
  assert.ok(isRoleId("admin"));
  assert.ok(isRoleId("partner-agency"));
  assert.ok(isRoleId("tier_2"));
  assert.ok(!isRoleId("Admin"));
  assert.ok(!isRoleId("2fa"));
  assert.ok(!isRoleId(""));
  assert.ok(!isRoleId("a".repeat(33)));
  assert.ok(!isRoleId(undefined));
  assert.ok(!isRoleId(["admin"]));
});

test("a role id is made from the display name", () => {
  assert.equal(roleIdFromName("Partner agency"), "partner-agency");
  assert.equal(roleIdFromName("  Client  "), "client");
  assert.equal(roleIdFromName("VIP (2026)"), "vip-2026");
  assert.equal(roleIdFromName("2nd tier"), "nd-tier");
  assert.equal(roleIdFromName("!!!"), null);
  assert.equal(roleIdFromName("x".repeat(50))?.length, 32);
});

test("admins pass every check, others need their role listed", () => {
  assert.ok(roleAllows("admin", ["client"]));
  assert.ok(roleAllows("admin", []));
  assert.ok(roleAllows("client", ["client", "member"]));
  assert.ok(!roleAllows("client", ["admin"]));
  assert.ok(!roleAllows("member", ["client"]));
  assert.ok(roleAllows("partner-agency", ["partner-agency"]));
});
