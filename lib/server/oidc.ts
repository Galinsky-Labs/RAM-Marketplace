import "server-only";
import {
  validateDiscovery,
  type OidcConfig,
  type OidcDiscovery
} from "@/lib/auth/oidc";
import type { JsonWebKey } from "node:crypto";

const TTL_MS = 10 * 60 * 1000;
let discoveryCache: { issuer: string; at: number; value: OidcDiscovery } | null = null;
let jwksCache: { uri: string; at: number; value: { keys?: JsonWebKey[] } } | null = null;

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  if (text.length > 262_144) throw new Error("OIDC provider response too large");
  if (response.status >= 400 && response.status < 500 && init?.method === "POST") {
    // invalid_grant / invalid_client: an authentication failure, not an outage.
    throw new Error("OIDC authorization code was rejected by the identity provider");
  }
  if (!response.ok) throw new Error("OIDC provider HTTP " + response.status);
  return JSON.parse(text);
}

export async function oidcDiscovery(config: OidcConfig): Promise<OidcDiscovery> {
  if (discoveryCache && discoveryCache.issuer === config.issuer && Date.now() - discoveryCache.at < TTL_MS) {
    return discoveryCache.value;
  }
  const value = validateDiscovery(config, await fetchJson(config.issuer + "/.well-known/openid-configuration"));
  discoveryCache = { issuer: config.issuer, at: Date.now(), value };
  return value;
}

export async function oidcJwks(discovery: OidcDiscovery, forceRefresh = false) {
  if (!forceRefresh && jwksCache && jwksCache.uri === discovery.jwks_uri && Date.now() - jwksCache.at < TTL_MS) {
    return jwksCache.value;
  }
  const value = await fetchJson(discovery.jwks_uri) as { keys?: JsonWebKey[] };
  if (!value || !Array.isArray(value.keys)) throw new Error("OIDC JWKS is invalid");
  jwksCache = { uri: discovery.jwks_uri, at: Date.now(), value };
  return value;
}

/** Exchange an authorization code (client_secret_basic + PKCE). */
export async function exchangeCode(config: OidcConfig, discovery: OidcDiscovery, code: string, codeVerifier: string) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    code_verifier: codeVerifier
  });
  const basic = Buffer.from(encodeURIComponent(config.clientId) + ":" + encodeURIComponent(config.clientSecret)).toString("base64");
  const tokens = await fetchJson(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic " + basic, accept: "application/json" },
    body
  }) as { id_token?: unknown };
  if (typeof tokens?.id_token !== "string") throw new Error("OIDC token response has no id_token");
  return tokens.id_token;
}
