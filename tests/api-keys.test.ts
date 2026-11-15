import assert from "node:assert/strict";
import test from "node:test";
import {
  apiKeyAuthorizes, apiKeyExpiry, generateApiKey, hashApiKey,
  normalizeApiKeyName, normalizeApiKeyScopes, parseApiKeyHeader
} from "../lib/auth/api-keys";

const now = new Date("2026-11-15T00:00:00Z");

test("generated keys parse, hash and never equal their stored hash", () => {
  const key = generateApiKey();
  assert.match(key.token, /^ramk_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(key.keyHash, key.token);
  assert.equal(key.keyHash, hashApiKey(key.token));
  assert.deepEqual(parseApiKeyHeader("Bearer " + key.token), { token: key.token, prefix: key.prefix });
  assert.notEqual(generateApiKey().token, key.token);
});

test("malformed headers are rejected", () => {
  assert.equal(parseApiKeyHeader(null), null);
  assert.equal(parseApiKeyHeader("Basic abc"), null);
  assert.equal(parseApiKeyHeader("Bearer ramk_short_x"), null);
  assert.equal(parseApiKeyHeader("Bearer  ramk_aaaaaaaaaaaa_" + "a".repeat(43)), null);
});

test("authorization requires matching hash, scope, unrevoked and unexpired", () => {
  const key = generateApiKey();
  const stored = { keyHash: key.keyHash, scopes: ["supplier-batch:write"], revokedAt: null, expiresAt: new Date(now.getTime() + 1000) };
  assert.equal(apiKeyAuthorizes(stored, key.token, "supplier-batch:write", now), true);
  assert.equal(apiKeyAuthorizes(stored, key.token, "supplier-batch:read", now), false);
  assert.equal(apiKeyAuthorizes({ ...stored, revokedAt: now }, key.token, "supplier-batch:write", now), false);
  assert.equal(apiKeyAuthorizes({ ...stored, expiresAt: now }, key.token, "supplier-batch:write", now), false);
  assert.equal(apiKeyAuthorizes(stored, generateApiKey().token, "supplier-batch:write", now), false);
  assert.equal(apiKeyAuthorizes(null, key.token, "supplier-batch:write", now), false);
});

test("scope, name and lifetime inputs are bounded", () => {
  assert.deepEqual(normalizeApiKeyScopes(["supplier-batch:write", "supplier-batch:write"]), ["supplier-batch:write"]);
  assert.throws(() => normalizeApiKeyScopes(["admin:manage"]), /Unknown/);
  assert.throws(() => normalizeApiKeyScopes([]), /At least one/);
  assert.throws(() => normalizeApiKeyName("x"), /3 to 80/);
  assert.equal(apiKeyExpiry(undefined, now).getTime(), now.getTime() + 90 * 86_400_000);
  assert.throws(() => apiKeyExpiry(366, now), /1 to 365/);
  assert.throws(() => apiKeyExpiry(1.5, now), /1 to 365/);
});
