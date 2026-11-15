import "server-only";
import type { SessionPrincipal } from "@/lib/auth/token";
import { requirePrisma } from "@/lib/server/db";
import { assertActivationApproval, normalizeActivationInput, type ActivationStatus } from "@/lib/jurisdictions";

function authorize(principal: SessionPrincipal) {
  if (principal.role !== "RAM_COMPLIANCE" && principal.role !== "RAM_SUPER_ADMIN") {
    throw new Error("Forbidden: RAM compliance reviewer required");
  }
}

export async function listJurisdictionActivations() {
  return requirePrisma().jurisdictionActivation.findMany({ orderBy: [{ species: "asc" }, { stateCode: "asc" }], take: 500 });
}

export async function listJurisdictionsForReview(principal: SessionPrincipal) {
  authorize(principal);
  return listJurisdictionActivations();
}

async function audit(principal: SessionPrincipal, action: string, id: string, previous: unknown, next: unknown, metadata?: unknown) {
  await requirePrisma().auditEvent.create({
    data: {
      actorUserId: principal.userId, organizationId: principal.organizationId, action,
      entityType: "JurisdictionActivation", entityId: id,
      previousState: previous as never, nextState: next as never, metadata: metadata as never
    }
  });
}

/** Propose (or re-propose a suspended) state activation for a pilot species. */
export async function proposeJurisdiction(principal: SessionPrincipal, input: { stateCode?: unknown; species?: unknown; evidenceReference?: unknown }) {
  authorize(principal);
  const value = normalizeActivationInput(input);
  const db = requirePrisma();
  const existing = await db.jurisdictionActivation.findUnique({ where: { stateCode_species: { stateCode: value.stateCode, species: value.species } } });
  if (existing && existing.status !== "SUSPENDED") throw new Error("Conflict: jurisdiction is already " + existing.status.toLowerCase());
  const record = existing
    ? await db.jurisdictionActivation.update({
        where: { id: existing.id },
        data: { status: "PROPOSED", evidenceReference: value.evidenceReference, proposedById: principal.userId, approvedById: null, activatedAt: null }
      })
    : await db.jurisdictionActivation.create({ data: { ...value, proposedById: principal.userId } });
  await audit(principal, "JURISDICTION_PROPOSED", record.id, existing ? { status: existing.status } : null, { status: "PROPOSED", ...value });
  return record;
}

export async function approveJurisdiction(principal: SessionPrincipal, id: string, now = new Date()) {
  authorize(principal);
  const db = requirePrisma();
  const record = await db.jurisdictionActivation.findUnique({ where: { id } });
  if (!record) throw new Error("Jurisdiction activation not found");
  assertActivationApproval({ status: record.status as ActivationStatus, proposedById: record.proposedById }, principal.userId);
  const claimed = await db.jurisdictionActivation.updateMany({
    where: { id, status: "PROPOSED" },
    data: { status: "ACTIVE", approvedById: principal.userId, activatedAt: now, suspendedAt: null, suspendedById: null, suspendedReason: null }
  });
  if (claimed.count !== 1) throw new Error("Conflict: activation changed concurrently");
  await audit(principal, "JURISDICTION_ACTIVATED", id, { status: "PROPOSED" }, { status: "ACTIVE" }, { stateCode: record.stateCode, species: record.species });
  return db.jurisdictionActivation.findUniqueOrThrow({ where: { id } });
}

export async function suspendJurisdiction(principal: SessionPrincipal, id: string, reason: string, now = new Date()) {
  authorize(principal);
  const trimmed = reason?.trim() ?? "";
  if (trimmed.length < 5 || trimmed.length > 2000) throw new Error("A suspension reason of 5 to 2000 characters is required");
  const db = requirePrisma();
  const record = await db.jurisdictionActivation.findUnique({ where: { id } });
  if (!record) throw new Error("Jurisdiction activation not found");
  if (record.status === "SUSPENDED") return record;
  const updated = await db.jurisdictionActivation.update({
    where: { id },
    data: { status: "SUSPENDED", suspendedById: principal.userId, suspendedAt: now, suspendedReason: trimmed }
  });
  await audit(principal, "JURISDICTION_SUSPENDED", id, { status: record.status }, { status: "SUSPENDED" }, { reason: trimmed });
  return updated;
}
