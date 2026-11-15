import "server-only";
import { createHash } from "node:crypto";
import type { SessionPrincipal } from "@/lib/auth/token";
import { requireCapability } from "@/lib/access";
import { requirePrisma } from "@/lib/server/db";
import { reconcilePayments, statementSchema } from "@/lib/payment-reconciliation";

/**
 * Reconcile a provider statement (manually exported, or pulled by a provider
 * adapter such as Stripe) against RAM payment executions for the period.
 * Re-submitting the identical statement is idempotent.
 */
export async function runPaymentReconciliation(principal: SessionPrincipal, raw: unknown) {
  requireCapability(principal.role, "settlement:manage");
  const parsed = statementSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Invalid provider statement: " + parsed.error.issues.map((i) => i.path.join(".") || i.message).slice(0, 8).join(", "));
  }
  const statement = parsed.data;
  const statementHash = createHash("sha256").update(JSON.stringify(statement)).digest("hex");
  const periodStart = new Date(statement.periodStart);
  const periodEnd = new Date(statement.periodEnd);
  const db = requirePrisma();

  const existing = await db.paymentReconciliationRun.findUnique({
    where: { provider_statementHash: { provider: statement.provider, statementHash } }
  });
  if (existing) return { run: existing, replay: true };

  const executions = await db.paymentExecution.findMany({
    where: {
      OR: [{ gateway: statement.provider }, { provider: statement.provider }],
      submittedAt: { gte: periodStart, lt: periodEnd }
    },
    select: { id: true, idempotencyKey: true, providerReference: true, amountCents: true, currency: true, status: true, type: true },
    take: 10_000
  });
  const result = reconcilePayments(executions, statement.lines);
  const run = await db.$transaction(async (tx) => {
    const created = await tx.paymentReconciliationRun.create({
      data: {
        provider: statement.provider,
        periodStart,
        periodEnd,
        statementHash,
        lineCount: statement.lines.length,
        executionCount: executions.length,
        matched: result.matched,
        discrepancyCount: result.discrepancies.length,
        ramSucceededCents: result.ramSucceededCents,
        providerSucceededCents: result.providerSucceededCents,
        reconciled: result.reconciled,
        discrepancies: JSON.parse(JSON.stringify(result.discrepancies)),
        createdById: principal.userId
      }
    });
    await tx.auditEvent.create({
      data: {
        actorUserId: principal.userId,
        organizationId: principal.organizationId,
        action: result.reconciled ? "PAYMENT_RECONCILIATION_CLEAN" : "PAYMENT_RECONCILIATION_DISCREPANCY",
        entityType: "PaymentReconciliationRun",
        entityId: created.id,
        nextState: { reconciled: result.reconciled, matched: result.matched, discrepancies: result.discrepancies.length },
        metadata: { provider: statement.provider, periodStart: statement.periodStart, periodEnd: statement.periodEnd, statementHash }
      }
    });
    return created;
  });
  return { run, replay: false };
}

export async function listPaymentReconciliationRuns(principal: SessionPrincipal) {
  requireCapability(principal.role, "settlement:manage");
  return requirePrisma().paymentReconciliationRun.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
}
