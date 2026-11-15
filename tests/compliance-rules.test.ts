import assert from "node:assert/strict";
import test from "node:test";
import { createRuleDraft, reviseRuleDraft, type RuleDraftInput } from "../lib/compliance-rule-drafts";
import { assertPublishable, evaluateCorridor, toPublishedRule, type PublishedRule } from "../lib/compliance-rules";

const base: RuleDraftInput = {
  ruleId: "ia-ia-swine-resp",
  originState: "IA",
  destinationState: "IA",
  species: "Swine",
  conditionFamily: "Respiratory",
  prohibited: false,
  rationale: "Intrastate pilot corridor",
  sourceReferences: ["state-vet-memo-2026-01"],
  effectiveFrom: "2026-01-01",
  effectiveUntil: "2026-12-31",
  authorId: "author-1"
};
const at = new Date("2026-06-01T00:00:00Z");
const publish = (input: RuleDraftInput, revision = 1): PublishedRule => {
  let draft = createRuleDraft(input);
  while (draft.revision < revision) draft = reviseRuleDraft(draft, draft.digest, input);
  assertPublishable(draft, draft.digest, "publisher-2");
  return toPublishedRule(draft, "publisher-2", at);
};
const query = { originState: "ia", destinationState: "IA", species: "swine", conditionFamily: "respiratory", onDate: "2026-06-01" };

test("author cannot publish own revision; second reviewer can", () => {
  const draft = createRuleDraft(base);
  assert.throws(() => assertPublishable(draft, draft.digest, "author-1"), /cannot publish their own/);
  assert.doesNotThrow(() => assertPublishable(draft, draft.digest, "publisher-2"));
});

test("stale or tampered revisions cannot be published", () => {
  const draft = createRuleDraft(base);
  assert.throws(() => assertPublishable(draft, "0".repeat(64), "publisher-2"), /Stale/);
  const tampered = { ...draft, prohibited: true };
  assert.throws(() => assertPublishable(tampered, draft.digest, "publisher-2"), /does not match its digest/);
  assert.throws(() => assertPublishable({ ...draft, status: "PUBLISHED" } as never, draft.digest, "publisher-2"), /Only draft/);
});

test("corridors are denied by default", () => {
  const decision = evaluateCorridor([], query);
  assert.equal(decision.decision, "DENY");
});

test("published permit in effect allows the corridor with exact rule evidence", () => {
  const rule = publish(base);
  const decision = evaluateCorridor([rule], query);
  assert.equal(decision.decision, "ALLOW");
  if (decision.decision === "ALLOW") {
    assert.equal(decision.ruleId, base.ruleId);
    assert.equal(decision.digest, rule.digest);
  }
});

test("dates outside effect, other corridors and other species are denied", () => {
  const rule = publish(base);
  assert.equal(evaluateCorridor([rule], { ...query, onDate: "2027-01-01" }).decision, "DENY");
  assert.equal(evaluateCorridor([rule], { ...query, destinationState: "MN" }).decision, "DENY");
  assert.equal(evaluateCorridor([rule], { ...query, species: "Bovine" }).decision, "DENY");
  assert.equal(evaluateCorridor([rule], { ...query, onDate: "June 1" }).decision, "DENY");
  assert.equal(evaluateCorridor([rule], { ...query, species: " " }).decision, "DENY");
});

test("a matching published prohibition overrides any permit", () => {
  const permit = publish(base);
  const prohibition = publish({ ...base, ruleId: "ia-ia-swine-resp-outbreak-stop", prohibited: true, rationale: "Outbreak stop" });
  const decision = evaluateCorridor([permit, prohibition], query);
  assert.equal(decision.decision, "DENY");
  assert.equal(decision.ruleId, "ia-ia-swine-resp-outbreak-stop");
});

test("only the latest revision of a rule is applied", () => {
  const permitV1 = publish(base, 1);
  const prohibitV2 = publish({ ...base, prohibited: true }, 2);
  assert.equal(evaluateCorridor([permitV1, prohibitV2], query).decision, "DENY");
  const v2Permit = publish({ ...base, effectiveUntil: "2026-03-31" }, 2);
  assert.equal(evaluateCorridor([permitV1, v2Permit], query).decision, "DENY", "narrowed v2 supersedes v1");
});
