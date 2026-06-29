import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeSessionCookie,
  encodeSessionCookie,
  hashInvite,
  hashPassword,
  verifyPassword,
  verifyInvite
} from "../src/security.js";

test("invite verification accepts only matching sha256 digests", () => {
  const digest = hashInvite("friend-only-code");
  assert.equal(verifyInvite("friend-only-code", [digest]), true);
  assert.equal(verifyInvite("wrong-code", [digest]), false);
});

test("session cookie signature rejects tampering", () => {
  const cookie = encodeSessionCookie("session-1", "secret-1");
  assert.equal(decodeSessionCookie(cookie, "secret-1"), "session-1");
  assert.equal(decodeSessionCookie(cookie.replace("session-1", "session-2"), "secret-1"), null);
  assert.equal(decodeSessionCookie(cookie, "secret-2"), null);
});

test("password hashes verify without storing plain text", () => {
  const digest = hashPassword("correct horse battery");
  assert.notEqual(digest.includes("correct horse battery"), true);
  assert.equal(verifyPassword("correct horse battery", digest), true);
  assert.equal(verifyPassword("wrong password", digest), false);
});
