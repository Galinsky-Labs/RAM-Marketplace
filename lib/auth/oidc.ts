import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
  type JsonWebKey
} from "node:crypto";
import type { ExternalIdentityAssertionPayload } from "./external-assertion";

/**
 * Standards-based OpenID Connect relying party (Authorization Code + PKCE,
 * signed ID token verification against the provider's JWKS). Works with any
 * compliant provider (Okta, Entra ID, Google Workspace, Auth0, Keycloak, ...)
 * once RAM_OIDC_ISSUER, RAM_OIDC_CLIENT_ID, RAM_OIDC_CLIENT_SECRET and
 * RAM_OIDC_REDIRECT_URI are configured. Disabled otherwise; demo login is
 * unaffected.
 */
export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  providerName: string;
  scopes: string;
  requireMfa: boolean;
  mfaAcrValues: string[];
}

function httpsOrLoopback(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be a URL`);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) || url.username || url.password || url.hash) {
    throw new Error(`${label} must be an HTTPS URL without credentials or fragment`);
  }
  return url;
}

export function oidcConfig(env: Record<string, string | undefined> = process.env): OidcConfig | null {
  const issuer = env.RAM_OIDC_ISSUER?.trim();
  const clientId = env.RAM_OIDC_CLIENT_ID?.trim();
  const clientSecret = env.RAM_OIDC_CLIENT_SECRET?.trim();
  const redirectUri = env.RAM_OIDC_REDIRECT_URI?.trim();
  if (!issuer && !clientId && !clientSecret && !redirectUri) return null;
  if (!issuer || !clientId || !clientSecret || !redirectUri) {
    throw new Error("OIDC requires RAM_OIDC_ISSUER, RAM_OIDC_CLIENT_ID, RAM_OIDC_CLIENT_SECRET and RAM_OIDC_REDIRECT_URI");
  }
  httpsOrLoopback(issuer, "RAM_OIDC_ISSUER");
  const redirect = httpsOrLoopback(redirectUri, "RAM_OIDC_REDIRECT_URI");
  if (redirect.pathname !== "/api/session/oidc/callback") {
    throw new Error("RAM_OIDC_REDIRECT_URI must end with /api/session/oidc/callback");
  }
  const providerName = (env.RAM_OIDC_PROVIDER_NAME?.trim() || "oidc").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(providerName)) throw new Error("RAM_OIDC_PROVIDER_NAME is invalid");
  return {
    issuer: issuer.replace(/\/$/, ""),
    clientId,
    clientSecret,
    redirectUri: redirect.toString(),
    providerName,
    scopes: env.RAM_OIDC_SCOPES?.trim() || "openid email profile",
    requireMfa: env.RAM_IDENTITY_REQUIRE_MFA !== "false",
    mfaAcrValues: (env.RAM_OIDC_MFA_ACR_VALUES ?? "").split(",").map((v) => v.trim()).filter(Boolean)
  };
}

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

/** Validate a discovery document (issuer must match exactly, endpoints HTTPS). */
export function validateDiscovery(config: OidcConfig, document: unknown): OidcDiscovery {
  if (!document || typeof document !== "object") throw new Error("Invalid OIDC discovery document");
  const d = document as Record<string, unknown>;
  for (const key of ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    if (typeof d[key] !== "string") throw new Error(`OIDC discovery is missing ${key}`);
  }
  if ((d.issuer as string).replace(/\/$/, "") !== config.issuer) throw new Error("OIDC discovery issuer mismatch");
  for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    httpsOrLoopback(d[key] as string, "OIDC " + key);
  }
  return {
    issuer: d.issuer as string,
    authorization_endpoint: d.authorization_endpoint as string,
    token_endpoint: d.token_endpoint as string,
    jwks_uri: d.jwks_uri as string
  };
}

const b64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

export interface OidcLoginState {
  state: string;
  nonce: string;
  codeVerifier: string;
  next: string;
  exp: number;
}

export function createLoginState(next: string, nowMs = Date.now()): OidcLoginState {
  return {
    state: b64url(randomBytes(24)),
    nonce: b64url(randomBytes(24)),
    codeVerifier: b64url(randomBytes(48)),
    next: safeNext(next),
    exp: Math.floor(nowMs / 1000) + 600
  };
}

/** Only same-site relative paths are allowed as post-login destinations. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || /[\\\r\n]/.test(next)) return "/";
  return next.slice(0, 300);
}

export function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function authorizationUrl(config: OidcConfig, discovery: OidcDiscovery, login: OidcLoginState): string {
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scopes);
  url.searchParams.set("state", login.state);
  url.searchParams.set("nonce", login.nonce);
  url.searchParams.set("code_challenge", codeChallenge(login.codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  if (config.requireMfa && config.mfaAcrValues.length) url.searchParams.set("acr_values", config.mfaAcrValues.join(" "));
  return url.toString();
}

/** Signed, short-lived cookie that carries state/nonce/PKCE between start and callback. */
export function sealLoginState(login: OidcLoginState, secret: string): string {
  const body = b64url(JSON.stringify(login));
  const mac = createHmac("sha256", secret).update("ram-oidc-state." + body).digest("base64url");
  return body + "." + mac;
}

export function openLoginState(sealed: string | undefined, secret: string, nowMs = Date.now()): OidcLoginState {
  if (!sealed) throw new Error("OIDC login state is missing; start sign-in again");
  const [body, mac, extra] = sealed.split(".");
  if (!body || !mac || extra) throw new Error("OIDC login state is malformed");
  const expected = Buffer.from(createHmac("sha256", secret).update("ram-oidc-state." + body).digest("base64url"));
  const supplied = Buffer.from(mac);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new Error("OIDC login state signature is invalid");
  }
  const login = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OidcLoginState;
  if (typeof login.exp !== "number" || login.exp * 1000 < nowMs) throw new Error("OIDC login state expired; start sign-in again");
  return login;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const ALGORITHMS: Record<string, { hash: string; padding?: "pss"; ec?: boolean }> = {
  RS256: { hash: "sha256" }, RS384: { hash: "sha384" }, RS512: { hash: "sha512" },
  PS256: { hash: "sha256", padding: "pss" }, PS384: { hash: "sha384", padding: "pss" },
  ES256: { hash: "sha256", ec: true }, ES384: { hash: "sha384", ec: true }
};

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  azp?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  acr?: string;
  amr?: string[];
  jti?: string;
}

/**
 * Verify an ID token's signature (asymmetric algorithms only; "none" and HMAC
 * are refused), issuer, audience/azp, expiry, issued-at and nonce.
 */
export function verifyIdToken(
  idToken: string,
  jwks: { keys?: JsonWebKey[] },
  config: OidcConfig,
  expectedNonce: string,
  nowMs = Date.now(),
  clockSkewSeconds = 120
): IdTokenClaims {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("ID token is malformed");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as { alg?: string; kid?: string };
  const alg = ALGORITHMS[header.alg ?? ""];
  if (!alg) throw new Error("ID token algorithm is not allowed");
  const candidates = (jwks.keys ?? []).filter((key) =>
    (!header.kid || (key as { kid?: string }).kid === header.kid) &&
    (!(key as { use?: string }).use || (key as { use?: string }).use === "sig") &&
    (alg.ec ? key.kty === "EC" : key.kty === "RSA"));
  if (candidates.length === 0) throw new Error("No matching signing key for ID token");
  const signed = Buffer.from(parts[0] + "." + parts[1]);
  const signature = Buffer.from(parts[2], "base64url");
  const valid = candidates.some((jwk) => {
    try {
      const key = createPublicKey({ key: jwk, format: "jwk" });
      return verifySignature(alg.hash, signed, alg.padding === "pss"
        ? { key, padding: 6, saltLength: -1 }
        : alg.ec ? { key, dsaEncoding: "ieee-p1363" } : key, signature);
    } catch {
      return false;
    }
  });
  if (!valid) throw new Error("ID token signature is invalid");

  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as IdTokenClaims;
  const now = Math.floor(nowMs / 1000);
  if (typeof claims.iss !== "string" || claims.iss.replace(/\/$/, "") !== config.issuer) throw new Error("ID token issuer mismatch");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(config.clientId)) throw new Error("ID token audience mismatch");
  if (audiences.length > 1 && claims.azp !== config.clientId) throw new Error("ID token authorized party mismatch");
  if (typeof claims.exp !== "number" || claims.exp + clockSkewSeconds < now) throw new Error("ID token expired");
  if (typeof claims.iat !== "number" || claims.iat - clockSkewSeconds > now || now - claims.iat > 3600) {
    throw new Error("ID token issued-at is outside the allowed window");
  }
  if (typeof claims.nonce !== "string" || !constantTimeEqual(claims.nonce, expectedNonce)) throw new Error("ID token nonce mismatch");
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255) throw new Error("ID token subject is invalid");
  return claims;
}

const MFA_AMR = new Set(["mfa", "otp", "hwk", "swk", "sms", "fido", "face", "fpt", "iris", "retina", "vbm", "pin", "sc"]);

/** Map verified claims into the RAM external identity assertion shape. */
export function claimsToAssertion(config: OidcConfig, claims: IdTokenClaims, idToken: string): ExternalIdentityAssertionPayload {
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error("OIDC identity has no valid email claim");
  const emailVerified = claims.email_verified === true || claims.email_verified === "true";
  const amr = Array.isArray(claims.amr) ? claims.amr.filter((v): v is string => typeof v === "string").slice(0, 20) : [];
  const mfa = amr.some((value) => MFA_AMR.has(value.toLowerCase())) ||
    (typeof claims.acr === "string" && config.mfaAcrValues.includes(claims.acr));
  if (config.requireMfa && !mfa) throw new Error("MFA is required: the identity provider did not assert multi-factor authentication");
  return {
    v: 1,
    aud: "ram-marketplace",
    provider: config.providerName,
    subject: claims.sub,
    email,
    name: (typeof claims.name === "string" && claims.name.trim() ? claims.name.trim() : email).slice(0, 200),
    emailVerified,
    mfa,
    acr: typeof claims.acr === "string" ? claims.acr : undefined,
    amr,
    // One-time use is enforced on a hash of the exact ID token.
    jti: "oidc-" + createHash("sha256").update(idToken).digest("hex").slice(0, 48),
    iat: claims.iat,
    exp: claims.exp
  };
}
