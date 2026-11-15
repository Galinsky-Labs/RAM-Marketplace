import { ruleDraftDigestValid, type RuleDraft } from "./compliance-rule-drafts";

/**
 * Published compliance rules. A rule is only usable after a second, distinct
 * RAM compliance principal publishes an exact, digest-verified draft revision.
 * Corridor decisions are deny-by-default: no published permitting rule means
 * no movement, and any matching published prohibition wins.
 */
export interface PublishedRule extends Omit<RuleDraft, "status"> {
  status: "PUBLISHED";
  publishedById: string;
  publishedAt: string;
}

export interface CorridorQuery {
  originState: string;
  destinationState: string;
  species: string;
  conditionFamily: string;
  /** ISO calendar date (YYYY-MM-DD) on which movement would occur. */
  onDate: string;
}

export type CorridorDecision =
  | { decision: "ALLOW"; ruleId: string; revision: number; digest: string }
  | { decision: "DENY"; reason: string; ruleId?: string; revision?: number; digest?: string };

/** Verify a persisted draft is unaltered and may be published by this principal. */
export function assertPublishable(
  draft: RuleDraft,
  expectedDigest: string,
  publisherId: string
): void {
  if (!draft || draft.status !== "DRAFT") throw new Error("Only draft revisions can be published");
  if (typeof expectedDigest !== "string" || draft.digest !== expectedDigest) {
    throw new Error("Stale rule revision: digest does not match");
  }
  if (!ruleDraftDigestValid(draft)) {
    throw new Error("Rule revision content does not match its digest");
  }
  if (!publisherId.trim()) throw new Error("Publisher is required");
  if (publisherId === draft.authorId) {
    throw new Error("Forbidden: a rule author cannot publish their own revision");
  }
}

export function toPublishedRule(draft: RuleDraft, publisherId: string, publishedAt: Date): PublishedRule {
  return {
    ...draft,
    status: "PUBLISHED",
    publishedById: publisherId,
    publishedAt: publishedAt.toISOString()
  };
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const norm = (value: string) => value.trim().toLowerCase();

/**
 * Decide a corridor from the latest published revision of each rule.
 * Callers must pass only current (non-superseded) publications.
 */
export function evaluateCorridor(
  rules: readonly PublishedRule[],
  query: CorridorQuery
): CorridorDecision {
  if (!isoDate.test(query.onDate)) return { decision: "DENY", reason: "Invalid movement date" };
  for (const key of ["originState", "destinationState", "species", "conditionFamily"] as const) {
    if (typeof query[key] !== "string" || !query[key].trim()) {
      return { decision: "DENY", reason: "Incomplete corridor query" };
    }
  }
  const latest = new Map<string, PublishedRule>();
  for (const rule of rules) {
    if (rule.status !== "PUBLISHED") continue;
    const current = latest.get(rule.ruleId);
    if (!current || current.revision < rule.revision) latest.set(rule.ruleId, rule);
  }
  const applicable = [...latest.values()].filter((rule) =>
    rule.originState === query.originState.toUpperCase() &&
    rule.destinationState === query.destinationState.toUpperCase() &&
    norm(rule.species) === norm(query.species) &&
    norm(rule.conditionFamily) === norm(query.conditionFamily) &&
    rule.effectiveFrom <= query.onDate &&
    query.onDate <= rule.effectiveUntil
  ).sort((a, b) => a.ruleId.localeCompare(b.ruleId));

  const prohibition = applicable.find((rule) => rule.prohibited);
  if (prohibition) {
    return {
      decision: "DENY",
      reason: "Published prohibition applies",
      ruleId: prohibition.ruleId,
      revision: prohibition.revision,
      digest: prohibition.digest
    };
  }
  const permit = applicable[0];
  if (!permit) return { decision: "DENY", reason: "No published rule permits this corridor" };
  return { decision: "ALLOW", ruleId: permit.ruleId, revision: permit.revision, digest: permit.digest };
}
