import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCOUNT_ROLES, DEFAULT_ROLE, ROLE_INFO, isAccountRole, roleAllows } from "./roles";

test("the three Devforge roles, member by default", () => {
  assert.deepEqual([...ACCOUNT_ROLES], ["admin", "client", "member"]);
  assert.equal(DEFAULT_ROLE, "member");
  for (const r of ACCOUNT_ROLES) assert.ok(ROLE_INFO[r].label && ROLE_INFO[r].summary);
});

test("isAccountRole accepts only the three roles", () => {
  assert.ok(isAccountRole("admin"));
  assert.ok(isAccountRole("client"));
  assert.ok(isAccountRole("member"));
  assert.ok(!isAccountRole("reader"));
  assert.ok(!isAccountRole("Admin"));
  assert.ok(!isAccountRole(""));
  assert.ok(!isAccountRole(undefined));
  assert.ok(!isAccountRole(["admin"]));
});

test("admins pass every check, others need their role listed", () => {
  assert.ok(roleAllows("admin", ["client"]));
  assert.ok(roleAllows("admin", []));
  assert.ok(roleAllows("client", ["client", "member"]));
  assert.ok(!roleAllows("client", ["admin"]));
  assert.ok(!roleAllows("member", ["client"]));
  assert.ok(roleAllows("member", ["member"]));
});
