import "server-only";
import type { SessionPrincipal } from "@/lib/auth/token";
import { requireCapability, can } from "@/lib/access";
import { requirePrisma } from "@/lib/server/db";
import { diagnosticReviewFlag, type DiagnosticReportInput } from "@/lib/diagnostics";

/** Persist a verified lab report idempotently. Never changes case status. */
export async function ingestDiagnosticReport(provider: string, report: DiagnosticReportInput, payloadHash: string) {
  const db = requirePrisma();
  return db.$transaction(async (tx) => {
    const existing = await tx.diagnosticReport.findUnique({
      where: { provider_externalReportId: { provider, externalReportId: report.externalReportId } }
    });
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new Error("Conflict: report id was reused with different content; send a CORRECTED report with a new id");
      }
      return { id: existing.id, replay: true, reviewFlag: existing.reviewFlag };
    }
    const animal = await tx.animalCase.findUnique({ where: { publicId: report.animalCaseId }, select: { publicId: true } });
    if (!animal) throw new Error("Unknown animal case");
    const reviewFlag = diagnosticReviewFlag(report);
    const created = await tx.diagnosticReport.create({
      data: {
        provider,
        externalReportId: report.externalReportId,
        animalCaseId: report.animalCaseId,
        testCode: report.testCode,
        testName: report.testName,
        resultStatus: report.resultStatus,
        interpretation: report.interpretation,
        reportable: report.reportable,
        reviewFlag,
        reportedAt: new Date(report.reportedAt),
        specimenCollectedAt: report.specimenCollectedAt ? new Date(report.specimenCollectedAt) : null,
        payload: JSON.parse(JSON.stringify(report)),
        payloadHash
      }
    });
    await tx.auditEvent.create({
      data: {
        action: "DIAGNOSTIC_REPORT_RECEIVED",
        entityType: "AnimalCase",
        entityId: report.animalCaseId,
        nextState: { diagnosticReportId: created.id, reviewFlag },
        metadata: { provider, externalReportId: report.externalReportId, testCode: report.testCode }
      }
    });
    return { id: created.id, replay: false, reviewFlag };
  });
}

export async function listDiagnosticReports(principal: SessionPrincipal, animalCaseId: string) {
  if (!can(principal.role, "animal:verify") && !can(principal.role, "source:read_restricted")) {
    throw new Error("Forbidden: veterinary or RAM compliance role required");
  }
  const db = requirePrisma();
  return db.diagnosticReport.findMany({
    where: { animalCaseId },
    orderBy: { reportedAt: "desc" },
    take: 100
  });
}

export async function acknowledgeDiagnosticReport(principal: SessionPrincipal, id: string, note: string, now = new Date()) {
  requireCapability(principal.role, "animal:verify");
  const trimmed = note?.trim() ?? "";
  if (trimmed.length < 5 || trimmed.length > 2000) throw new Error("Acknowledgement note must be 5 to 2000 characters");
  const db = requirePrisma();
  return db.$transaction(async (tx) => {
    const updated = await tx.diagnosticReport.updateMany({
      where: { id, acknowledgedAt: null },
      data: { acknowledgedById: principal.userId, acknowledgedAt: now, acknowledgementNote: trimmed }
    });
    if (updated.count !== 1) throw new Error("Diagnostic report not found or already acknowledged");
    const report = await tx.diagnosticReport.findUniqueOrThrow({ where: { id } });
    await tx.auditEvent.create({
      data: {
        actorUserId: principal.userId,
        organizationId: principal.organizationId,
        action: "DIAGNOSTIC_REPORT_ACKNOWLEDGED",
        entityType: "AnimalCase",
        entityId: report.animalCaseId,
        nextState: { diagnosticReportId: id, reviewFlag: report.reviewFlag },
        metadata: { note: trimmed }
      }
    });
    return report;
  });
}
