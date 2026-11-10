import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, normalizeEmail, readCookie, sessionCookie, verifyPassword } from "../src/server/auth";

test("passwords are salted, hashed and checked", async () => {
  const a = await hashPassword("correct horse battery");
  const b = await hashPassword("correct horse battery");
  assert.notEqual(a, b, "each hash has its own salt");
  assert.ok(!a.includes("correct horse"), "the password itself is never stored");
  assert.equal(await verifyPassword("correct horse battery", a), true);
  assert.equal(await verifyPassword("correct horse batterY", a), false);
  assert.equal(await verifyPassword("anything", "garbage"), false);
});

test("emails are normalized and checked", () => {
  assert.equal(normalizeEmail("  Ana@Example.COM "), "ana@example.com");
  assert.throws(() => normalizeEmail("not-an-email"));
  assert.throws(() => normalizeEmail(""));
});

test("session cookie is httpOnly and same-site", () => {
  const c = sessionCookie("tok123", true);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Secure/);
  assert.equal(readCookie("a=1; gb_session=tok123; b=2", "gb_session"), "tok123");
  assert.equal(readCookie(undefined, "gb_session"), null);
});
