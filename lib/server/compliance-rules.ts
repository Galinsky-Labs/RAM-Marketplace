import "server-only";
import type { SessionPrincipal } from "@/lib/auth/token";
import { requirePrisma } from "@/lib/server/db";
import type { RuleDraft } from "@/lib/compliance-rule-drafts";
import {
  assertPublishable,
  evaluateCorridor,
  toPublishedRule,
  type CorridorQuery,
  type PublishedRule
} from "@/lib/compliance-rules";

function authorizePublisher(principal: SessionPrincipal) {
  if (principal.role !== "RAM_COMPLIANCE" && principal.role !== "RAM_SUPER_ADMIN") {
    throw new Error("Forbidden: RAM compliance publisher required");
  }
}

/**
 * Publish one exact draft revision. A second principal (not the author) must
 * publish; the previous publication of the same rule is superseded atomically.
 */
export async function publishComplianceRule(
  principal: SessionPrincipal,
  input: { ruleId: string; revision: number; digest: string },
  now = new Date()
): Promise<PublishedRule> {
  authorizePublisher(principal);
  if (typeof input.ruleId !== "string" || !input.ruleId || input.ruleId.length > 160 ||
      !Number.isInteger(input.revision) || input.revision < 1 || typeof input.digest !== "string") {
    throw new Error("Invalid publication request");
  }
  const db = requirePrisma();
  return db.$transaction(async (tx) => {
    const draftRow = await tx.complianceRuleDraftRevision.findUnique({
      where: { ruleId_revision: { ruleId: input.ruleId, revision: input.revision } }
    });
    if (!draftRow) throw new Error("Rule draft revision not found");
    const draft = draftRow.payload as unknown as RuleDraft;
    if (draftRow.authorUserId !== draft.authorId) throw new Error("Rule draft author record is inconsistent");
    assertPublishable(draft, input.digest, principal.userId);

    const current = await tx.complianceRulePublication.findFirst({
      where: { ruleId: input.ruleId, supersededAt: null },
      orderBy: { revision: "desc" }
    });
    if (current && current.revision >= input.revision) {
      throw new Error("A newer or equal revision of this rule is already published");
    }
    if (current) {
      await tx.complianceRulePublication.update({
        where: { id: current.id },
        data: { supersededAt: now }
      });
    }
    const published = toPublishedRule(draft, principal.userId, now);
    await tx.complianceRulePublication.create({
      data: {
        ruleId: draft.ruleId,
        revision: draft.revision,
        digest: draft.digest,
        payload: JSON.parse(JSON.stringify(published)),
        authorUserId: draft.authorId,
        publishedById: principal.userId,
        publishedAt: now
      }
    });
    await tx.auditEvent.create({
      data: {
        actorUserId: principal.userId,
        organizationId: principal.organizationId,
        action: "COMPLIANCE_RULE_PUBLISHED",
        entityType: "ComplianceRulePublication",
        entityId: draft.ruleId,
        previousState: current ? { revision: current.revision, digest: current.digest } : undefined,
        nextState: { revision: draft.revision, digest: draft.digest, status: "PUBLISHED", prohibited: draft.prohibited }
      }
    });
    return published;
  });
}

export async function listCurrentPublishedRules(): Promise<PublishedRule[]> {
  const db = requirePrisma();
  const rows = await db.complianceRulePublication.findMany({
    where: { supersededAt: null },
    orderBy: [{ ruleId: "asc" }, { revision: "desc" }],
    take: 500
  });
  return rows.map((row) => row.payload as unknown as PublishedRule);
}

export async function listPublishedRulesForReview(principal: SessionPrincipal) {
  authorizePublisher(principal);
  return listCurrentPublishedRules();
}

/** Server-side corridor decision used by transport gating. Deny by default. */
export async function decideCorridor(query: CorridorQuery) {
  return evaluateCorridor(await listCurrentPublishedRules(), query);
}
