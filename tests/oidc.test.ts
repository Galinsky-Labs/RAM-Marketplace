import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";
import {
  authorizationUrl, claimsToAssertion, codeChallenge, createLoginState, oidcConfig,
  openLoginState, safeNext, sealLoginState, validateDiscovery, verifyIdToken
} from "../lib/auth/oidc";

const env = {
  RAM_OIDC_ISSUER: "https://idp.example.test/realm",
  RAM_OIDC_CLIENT_ID: "ram-client",
  RAM_OIDC_CLIENT_SECRET: "client-secret-value",
  RAM_OIDC_REDIRECT_URI: "https://ram.example.test/api/session/oidc/callback",
  RAM_OIDC_PROVIDER_NAME: "acme-okta"
};
const config = oidcConfig(env)!;
const discovery = validateDiscovery(config, {
  issuer: "https://idp.example.test/realm",
  authorization_endpoint: "https://idp.example.test/realm/authorize",
  token_endpoint: "https://idp.example.test/realm/token",
  jwks_uri: "https://idp.example.test/realm/jwks"
});
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const rsaJwk = { ...(rsa.publicKey.export({ format: "jwk" }) as JsonWebKey), kid: "k1", use: "sig" };
const ecJwk = { ...(ec.publicKey.export({ format: "jwk" }) as JsonWebKey), kid: "k2" };
const now = 1_763_200_000_000;
const nowS = now / 1000;

function jwt(claims: Record<string, unknown>, alg = "RS256", kid = "k1") {
  const header = Buffer.from(JSON.stringify({ alg, kid, typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const data = Buffer.from(header + "." + body);
  const signature = alg === "ES256"
    ? sign("sha256", data, { key: ec.privateKey, dsaEncoding: "ieee-p1363" })
    : alg === "none" ? Buffer.alloc(0) : sign("sha256", data, rsa.privateKey);
  return header + "." + body + "." + signature.toString("base64url");
}
const good = { iss: env.RAM_OIDC_ISSUER, aud: "ram-client", sub: "user-1", exp: nowS + 300, iat: nowS - 5, nonce: "n-1",
  email: "Pat@Example.Org", email_verified: true, name: "Pat Lee", amr: ["pwd", "mfa"] };

test("config is optional, all-or-nothing and requires the callback path", () => {
  assert.equal(oidcConfig({}), null);
  assert.throws(() => oidcConfig({ RAM_OIDC_ISSUER: env.RAM_OIDC_ISSUER }), /requires/);
  assert.throws(() => oidcConfig({ ...env, RAM_OIDC_REDIRECT_URI: "https://ram.example.test/other" }), /callback/);
  assert.throws(() => oidcConfig({ ...env, RAM_OIDC_ISSUER: "http://idp.example.test" }), /HTTPS/);
  assert.equal(config.requireMfa, true);
});

test("discovery must match the issuer exactly", () => {
  assert.throws(() => validateDiscovery(config, { ...discovery, issuer: "https://evil.test" }), /issuer mismatch/);
  assert.throws(() => validateDiscovery(config, { ...discovery, token_endpoint: "http://idp.example.test/token" }), /HTTPS/);
});

test("authorization URL carries state, nonce and S256 PKCE", () => {
  const login = createLoginState("/research", now);
  const url = new URL(authorizationUrl(config, discovery, login));
  assert.equal(url.searchParams.get("code_challenge"), codeChallenge(login.codeVerifier));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), login.state);
  assert.equal(url.searchParams.get("nonce"), login.nonce);
  assert.equal(url.searchParams.get("redirect_uri"), env.RAM_OIDC_REDIRECT_URI);
});

test("login state cookie is signed, expiring and only allows relative next paths", () => {
  const login = createLoginState("//evil.test", now);
  assert.equal(login.next, "/");
  assert.equal(safeNext("/farm?x=1"), "/farm?x=1");
  assert.equal(safeNext("https://evil.test"), "/");
  const sealed = sealLoginState(login, "s".repeat(32));
  assert.deepEqual(openLoginState(sealed, "s".repeat(32), now), login);
  assert.throws(() => openLoginState(sealed, "t".repeat(32), now), /signature/);
  assert.throws(() => openLoginState(sealed.replace(/^./, "x"), "s".repeat(32), now), /signature/);
  assert.throws(() => openLoginState(sealed, "s".repeat(32), now + 601_000), /expired/);
  assert.throws(() => openLoginState(undefined, "s".repeat(32), now), /missing/);
});

test("valid RS256 and ES256 ID tokens verify", () => {
  assert.equal(verifyIdToken(jwt(good), { keys: [rsaJwk] }, config, "n-1", now).sub, "user-1");
  assert.equal(verifyIdToken(jwt(good, "ES256", "k2"), { keys: [rsaJwk, ecJwk] }, config, "n-1", now).sub, "user-1");
});

test("forged, mis-addressed, expired, replayed-nonce and alg=none tokens are rejected", () => {
  const keys = { keys: [rsaJwk] };
  const token = jwt(good);
  const [h, b] = token.split(".");
  const tampered = h + "." + Buffer.from(JSON.stringify({ ...good, sub: "admin" })).toString("base64url") + "." + token.split(".")[2];
  assert.throws(() => verifyIdToken(tampered, keys, config, "n-1", now), /signature is invalid/);
  assert.throws(() => verifyIdToken(h + "." + b + ".", keys, config, "n-1", now), /signature is invalid/);
  assert.throws(() => verifyIdToken(jwt(good, "none"), keys, config, "n-1", now), /algorithm/);
  assert.throws(() => verifyIdToken(jwt(good, "HS256"), keys, config, "n-1", now), /algorithm/);
  assert.throws(() => verifyIdToken(jwt({ ...good, iss: "https://other" }), keys, config, "n-1", now), /issuer/);
  assert.throws(() => verifyIdToken(jwt({ ...good, aud: "other-client" }), keys, config, "n-1", now), /audience/);
  assert.throws(() => verifyIdToken(jwt({ ...good, aud: ["ram-client", "x"] }), keys, config, "n-1", now), /authorized party/);
  assert.throws(() => verifyIdToken(jwt({ ...good, exp: nowS - 300 }), keys, config, "n-1", now), /expired/);
  assert.throws(() => verifyIdToken(jwt(good), keys, config, "n-2", now), /nonce/);
  assert.throws(() => verifyIdToken(jwt(good, "RS256", "unknown"), keys, config, "n-1", now), /signing key/);
});

test("claims map to a one-time RAM identity assertion with MFA policy", () => {
  const token = jwt(good);
  const assertion = claimsToAssertion(config, good as never, token);
  assert.equal(assertion.provider, "acme-okta");
  assert.equal(assertion.email, "pat@example.org");
  assert.equal(assertion.mfa, true);
  assert.match(assertion.jti, /^oidc-[a-f0-9]{48}$/);
  assert.throws(() => claimsToAssertion(config, { ...good, amr: ["pwd"] } as never, token), /MFA is required/);
  const acrConfig = oidcConfig({ ...env, RAM_OIDC_MFA_ACR_VALUES: "urn:mfa" })!;
  assert.equal(claimsToAssertion(acrConfig, { ...good, amr: [], acr: "urn:mfa" } as never, token).mfa, true);
  const noMfa = oidcConfig({ ...env, RAM_IDENTITY_REQUIRE_MFA: "false" })!;
  assert.equal(claimsToAssertion(noMfa, { ...good, amr: ["pwd"] } as never, token).mfa, false);
  assert.throws(() => claimsToAssertion(config, { ...good, email: "not-an-email" } as never, token), /email/);
});
