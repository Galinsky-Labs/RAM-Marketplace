import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Organization-scoped enterprise API keys. Only a SHA-256 hash is stored; the
 * plaintext is shown once at creation. Keys carry explicit scopes and never
 * grant RAM staff, compliance, finance or administrative capabilities.
 */
export const API_KEY_SCOPES = ["supplier-batch:write", "supplier-batch:read"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

const TOKEN_PATTERN = /^ramk_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;
export const API_KEY_MAX_TTL_DAYS = 365;

export interface GeneratedApiKey {
  token: string;
  prefix: string;
  keyHash: string;
}

export function hashApiKey(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateApiKey(): GeneratedApiKey {
  const prefix = randomBytes(9).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "0").slice(0, 12);
  const secret = randomBytes(32).toString("base64url");
  const token = `ramk_${prefix}_${secret}`;
  return { token, prefix, keyHash: hashApiKey(token) };
}

/** Parse "Authorization: Bearer ramk_..." without echoing the credential. */
export function parseApiKeyHeader(header: string | null): { token: string; prefix: string } | null {
  if (!header) return null;
  const match = /^Bearer (\S+)$/.exec(header);
  if (!match) return null;
  const parsed = TOKEN_PATTERN.exec(match[1]);
  if (!parsed) return null;
  return { token: match[1], prefix: parsed[1] };
}

export function apiKeyHashMatches(token: string, storedHash: string): boolean {
  const supplied = Buffer.from(hashApiKey(token), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return supplied.length === stored.length && stored.length === 32 && timingSafeEqual(supplied, stored);
}

export function normalizeApiKeyScopes(value: unknown): ApiKeyScope[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > API_KEY_SCOPES.length) {
    throw new Error("At least one valid API key scope is required");
  }
  const scopes = new Set<ApiKeyScope>();
  for (const item of value) {
    if (typeof item !== "string" || !(API_KEY_SCOPES as readonly string[]).includes(item)) {
      throw new Error("Unknown API key scope");
    }
    scopes.add(item as ApiKeyScope);
  }
  return [...scopes].sort();
}

export function normalizeApiKeyName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 3 || value.length > 80) {
    throw new Error("API key name must be 3 to 80 characters");
  }
  return value.trim();
}

export function apiKeyExpiry(days: unknown, now: Date): Date {
  const n = days === undefined ? 90 : days;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > API_KEY_MAX_TTL_DAYS) {
    throw new Error(`API key lifetime must be 1 to ${API_KEY_MAX_TTL_DAYS} days`);
  }
  return new Date(now.getTime() + n * 86_400_000);
}

export interface StoredApiKey {
  keyHash: string;
  scopes: readonly string[];
  revokedAt: Date | null;
  expiresAt: Date;
}

/** Decide whether a stored key authorizes the requested scope right now. */
export function apiKeyAuthorizes(
  stored: StoredApiKey | null,
  token: string,
  scope: ApiKeyScope,
  now: Date
): boolean {
  if (!stored) return false;
  if (!apiKeyHashMatches(token, stored.keyHash)) return false;
  if (stored.revokedAt) return false;
  if (!(stored.expiresAt instanceof Date) || stored.expiresAt.getTime() <= now.getTime()) return false;
  return stored.scopes.includes(scope);
}
