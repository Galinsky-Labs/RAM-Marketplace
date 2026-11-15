import "server-only";
import type { NextRequest } from "next/server";
import type { SessionPrincipal } from "@/lib/auth/token";
import {
  apiKeyAuthorizes,
  apiKeyExpiry,
  generateApiKey,
  normalizeApiKeyName,
  normalizeApiKeyScopes,
  parseApiKeyHeader,
  type ApiKeyScope
} from "@/lib/auth/api-keys";
import { dataBackend, requirePrisma } from "@/lib/server/db";
import { requireOperationalPrincipal } from "@/lib/server/identity";
import { requireRequestSession } from "@/lib/auth/session";

function authorizeKeyAdmin(principal: SessionPrincipal) {
  if (principal.role !== "SUPPLIER_OWNER_ADMIN") {
    throw new Error("Forbidden: supplier organization administrator required");
  }
}

export async function createOrganizationApiKey(
  principal: SessionPrincipal,
  input: { name?: unknown; scopes?: unknown; ttlDays?: unknown },
  now = new Date()
) {
  authorizeKeyAdmin(principal);
  if (dataBackend() !== "postgres") throw new Error("API keys require PostgreSQL persistence");
  const name = normalizeApiKeyName(input.name);
  const scopes = normalizeApiKeyScopes(input.scopes);
  const expiresAt = apiKeyExpiry(input.ttlDays, now);
  const generated = generateApiKey();
  const db = requirePrisma();
  const created = await db.$transaction(async (tx) => {
    const activeCount = await tx.organizationApiKey.count({
      where: { organizationId: principal.organizationId, revokedAt: null, expiresAt: { gt: now } }
    });
    if (activeCount >= 10) throw new Error("Active API key limit reached; revoke an unused key first");
    const row = await tx.organizationApiKey.create({
      data: {
        organizationId: principal.organizationId,
        createdById: principal.userId,
        role: principal.role,
        name,
        prefix: generated.prefix,
        keyHash: generated.keyHash,
        scopes,
        expiresAt
      }
    });
    await tx.auditEvent.create({
      data: {
        actorUserId: principal.userId,
        organizationId: principal.organizationId,
        action: "ORGANIZATION_API_KEY_CREATED",
        entityType: "OrganizationApiKey",
        entityId: row.id,
        nextState: { prefix: row.prefix, scopes, expiresAt: expiresAt.toISOString() }
      }
    });
    return row;
  });
  // The plaintext token is returned exactly once and never persisted.
  return {
    id: created.id,
    name: created.name,
    prefix: created.prefix,
    scopes,
    expiresAt: created.expiresAt,
    token: generated.token
  };
}

export async function listOrganizationApiKeys(principal: SessionPrincipal) {
  authorizeKeyAdmin(principal);
  const db = requirePrisma();
  return db.organizationApiKey.findMany({
    where: { organizationId: principal.organizationId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true, name: true, prefix: true, scopes: true, expiresAt: true,
      revokedAt: true, lastUsedAt: true, createdAt: true
    }
  });
}

export async function revokeOrganizationApiKey(principal: SessionPrincipal, id: string, now = new Date()) {
  authorizeKeyAdmin(principal);
  const db = requirePrisma();
  return db.$transaction(async (tx) => {
    const key = await tx.organizationApiKey.findFirst({
      where: { id, organizationId: principal.organizationId }
    });
    if (!key) throw new Error("API key not found");
    if (key.revokedAt) return { id: key.id, revokedAt: key.revokedAt };
    const updated = await tx.organizationApiKey.update({ where: { id }, data: { revokedAt: now } });
    await tx.auditEvent.create({
      data: {
        actorUserId: principal.userId,
        organizationId: principal.organizationId,
        action: "ORGANIZATION_API_KEY_REVOKED",
        entityType: "OrganizationApiKey",
        entityId: id,
        previousState: { revokedAt: null },
        nextState: { revokedAt: now.toISOString() }
      }
    });
    return { id: updated.id, revokedAt: updated.revokedAt };
  });
}

/**
 * Resolve an API key to the creating member's principal. The member's current
 * membership and organization status are re-checked on every call, so member
 * suspension or organization revocation disables the key immediately.
 */
export async function authenticateApiKey(header: string | null, scope: ApiKeyScope, now = new Date()) {
  const parsed = parseApiKeyHeader(header);
  if (!parsed) return null;
  if (dataBackend() !== "postgres") throw new Error("API keys require PostgreSQL persistence");
  const db = requirePrisma();
  const key = await db.organizationApiKey.findUnique({
    where: { prefix: parsed.prefix },
    include: { createdBy: { select: { email: true, name: true } } }
  });
  if (!key || !apiKeyAuthorizes(key, parsed.token, scope, now)) {
    throw new Error("Authentication required: API key is invalid, expired, revoked or lacks scope");
  }
  const principal = await requireOperationalPrincipal({
    userId: key.createdById,
    organizationId: key.organizationId,
    role: key.role,
    email: key.createdBy.email,
    name: key.createdBy.name,
    exp: Math.floor(key.expiresAt.getTime() / 1000)
  });
  await db.organizationApiKey.update({ where: { id: key.id }, data: { lastUsedAt: now } });
  return principal;
}

/** Accept either an enterprise API key (Bearer ramk_...) or a browser session. */
export async function requireSessionOrApiKey(request: NextRequest, scope: ApiKeyScope) {
  const header = request.headers.get("authorization");
  if (header && header.startsWith("Bearer ramk_")) {
    const principal = await authenticateApiKey(header, scope);
    if (!principal) throw new Error("Authentication required: malformed API key");
    return principal;
  }
  return requireRequestSession(request);
}
