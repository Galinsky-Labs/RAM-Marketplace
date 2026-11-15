import "server-only";
import type { SessionPrincipal } from "@/lib/auth/token";
import { requireCapability } from "@/lib/access";
import { requirePrisma } from "@/lib/server/db";
import { animalCaseCreateData, publicAnimalId } from "@/lib/server/repositories";
import { previewSupplierBatch } from "@/lib/supplier-batch-preview";
import { animalSubmissionSchema } from "@/lib/validation";

/**
 * RAM operations verification of quarantined producer feeds. Promotion turns
 * each validated row into a SUBMITTED animal case (awaiting veterinary
 * pre-screen; never marketable, priced or movable on promotion).
 */
export async function listQuarantinedFeeds(principal: SessionPrincipal) {
  requireCapability(principal.role, "operations:manage");
  const db = requirePrisma();
  return db.supplierBatchImport.findMany({
    where: { state: "QUARANTINED" },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: {
      id: true, batchKey: true, rowCount: true, createdAt: true, state: true,
      organization: { select: { id: true, name: true } }
    }
  });
}

export async function reviewProducerFeed(
  principal: SessionPrincipal,
  input: { id: string; action: "PROMOTE" | "REJECT"; note: string },
  now = new Date()
) {
  requireCapability(principal.role, "operations:manage");
  const note = input.note?.trim() ?? "";
  if (note.length < 5 || note.length > 2000) throw new Error("A review note of 5 to 2000 characters is required");
  const db = requirePrisma();
  return db.$transaction(async (tx) => {
    const batch = await tx.supplierBatchImport.findUnique({
      where: { id: input.id },
      include: { createdBy: { select: { name: true, email: true } } }
    });
    if (!batch) throw new Error("Producer feed batch not found");
    // Compare-and-swap: only one reviewer can move a batch out of quarantine.
    const claimed = await tx.supplierBatchImport.updateMany({
      where: { id: batch.id, state: "QUARANTINED" },
      data: { state: input.action === "PROMOTE" ? "PROMOTED" : "REJECTED", reviewedById: principal.userId, reviewedAt: now, reviewNote: note }
    });
    if (claimed.count !== 1) throw new Error("Producer feed batch is no longer quarantined");

    let caseIds: string[] = [];
    if (input.action === "PROMOTE") {
      const preview = previewSupplierBatch(batch.organizationId, batch.rows);
      if (!preview.acceptedForReview) throw new Error("Stored batch no longer validates; reject it instead");
      const farmSite = await tx.farmSite.findFirst({
        where: { organizationId: batch.organizationId },
        include: { organization: true }
      });
      if (!farmSite) throw new Error("Supplier has no configured farm site");
      const rows = (batch.rows as { rows: { externalAnimalId: string; submission: unknown }[] }).rows;
      for (const row of rows) {
        const input = animalSubmissionSchema.parse(row.submission);
        const publicId = publicAnimalId(input.species);
        await tx.animalCase.create({
          data: animalCaseCreateData(publicId, input, farmSite, batch.createdBy)
        });
        await tx.auditEvent.create({
          data: {
            actorUserId: principal.userId,
            organizationId: batch.organizationId,
            action: "CANDIDATE_SUBMITTED",
            entityType: "AnimalCase",
            entityId: publicId,
            nextState: { status: "SUBMITTED" },
            metadata: { source: "PRODUCER_FEED", batchId: batch.id, externalAnimalId: row.externalAnimalId }
          }
        });
        caseIds.push(publicId);
      }
      await tx.supplierBatchImport.update({ where: { id: batch.id }, data: { promotedCaseIds: caseIds } });
    }
    await tx.auditEvent.create({
      data: {
        actorUserId: principal.userId,
        organizationId: principal.organizationId,
        action: input.action === "PROMOTE" ? "SUPPLIER_BATCH_PROMOTED" : "SUPPLIER_BATCH_REJECTED",
        entityType: "SupplierBatchImport",
        entityId: batch.id,
        previousState: { state: "QUARANTINED" },
        nextState: { state: input.action === "PROMOTE" ? "PROMOTED" : "REJECTED", caseCount: caseIds.length },
        metadata: { note }
      }
    });
    return { id: batch.id, state: input.action === "PROMOTE" ? "PROMOTED" : "REJECTED", caseIds };
  });
}
