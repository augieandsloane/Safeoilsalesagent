import test from "node:test";
import assert from "node:assert/strict";
import { decryptJson, encryptJson, pkceChallenge, safeEqual, sha256 } from "../src/security.js";

test("encrypts and authenticates token payloads", () => {
  const key = Buffer.alloc(32, 7);
  const encrypted = encryptJson({ access_token: "secret", refresh_token: "refresh" }, key);
  assert.ok(!encrypted.includes("secret"));
  assert.deepEqual(decryptJson(encrypted, key), { access_token: "secret", refresh_token: "refresh" });
  assert.throws(() => decryptJson(`${encrypted.slice(0, -1)}x`, key));
});

test("hash and PKCE helpers are deterministic", () => {
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(pkceChallenge("verifier"), "iMnq5o6zALKXGivsnlom_0F5_WYda32GHkxlV7mq7hQ");
  assert.equal(safeEqual("same", "same"), true);
  assert.equal(safeEqual("same", "different"), false);
});
