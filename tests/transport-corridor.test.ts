import assert from "node:assert/strict";
import test from "node:test";
import { applyCorridorGate, corridorEnforced } from "../lib/transport-corridor";

const allow = { decision: "ALLOW" as const, ruleId: "r1", revision: 2, digest: "d".repeat(64) };
const deny = { decision: "DENY" as const, reason: "No published rule permits this corridor" };

test("enforced corridor requires states and an ALLOW decision", () => {
  assert.throws(() => applyCorridorGate({ enforced: true, decision: allow }), /requires origin and destination/);
  assert.throws(() => applyCorridorGate({ enforced: true, originState: "IA", destinationState: "MN", decision: deny }), /Corridor denied: No published rule/);
  assert.throws(() => applyCorridorGate({ enforced: true, originState: "IA", destinationState: "MN", decision: null }), /Corridor denied/);
  const record = applyCorridorGate({ enforced: true, originState: "ia", destinationState: "mn", decision: allow });
  assert.deepEqual(record, { originState: "IA", destinationState: "MN", corridorDecision: "ALLOW", corridorEnforced: true, corridorRuleId: "r1", corridorRuleRevision: 2, corridorRuleDigest: allow.digest });
});

test("unenforced mode records the decision without blocking", () => {
  const record = applyCorridorGate({ enforced: false, originState: "IA", destinationState: "MN", decision: deny });
  assert.equal(record.corridorDecision, "DENY");
  assert.equal(record.corridorEnforced, false);
  assert.equal(applyCorridorGate({ enforced: false, decision: null }).corridorDecision, "NOT_EVALUATED");
});

test("invalid state codes are rejected in all modes", () => {
  assert.throws(() => applyCorridorGate({ enforced: false, originState: "Iowa", destinationState: "MN", decision: null }), /two-letter/);
});

test("enforcement is opt-in by explicit true only", () => {
  assert.equal(corridorEnforced({}), false);
  assert.equal(corridorEnforced({ RAM_CORRIDOR_RULES_ENFORCED: "1" }), false);
  assert.equal(corridorEnforced({ RAM_CORRIDOR_RULES_ENFORCED: "true" }), true);
});
