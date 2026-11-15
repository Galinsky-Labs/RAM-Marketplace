import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSpecies, speciesActivatable, speciesProfile, speciesProfileIssues } from "../lib/species";
import { assertActivationApproval, corridorJurisdictionsActive, normalizeActivationInput } from "../lib/jurisdictions";
import { approvePurchaseOrder, assertProcurementSatisfied, normalizeProcurementPolicy, normalizePurchaseOrderRequest } from "../lib/procurement";

test("species catalog: swine pilot, bovine groundwork, unknown passthrough", () => {
  assert.equal(normalizeSpecies(" swine "), "Swine");
  assert.equal(normalizeSpecies("Ovine"), "Ovine");
  assert.equal(speciesActivatable("Swine"), true);
  assert.equal(speciesActivatable("bovine"), false);
  assert.equal(speciesActivatable("Ovine"), false);
  assert.equal(speciesProfile("BOVINE")?.code, "BV");
  assert.deepEqual(speciesProfileIssues({ species: "Swine", weightKg: 120, ageMonths: 30 }), []);
  assert.equal(speciesProfileIssues({ species: "Swine", weightKg: 900 }).length, 1);
  assert.equal(speciesProfileIssues({ species: "Bovine", weightKg: 900 }).length, 0);
  assert.deepEqual(speciesProfileIssues({ species: "Ovine", weightKg: 9000 }), []);
});

test("jurisdiction activation input, two-person approval and groundwork refusal", () => {
  assert.deepEqual(normalizeActivationInput({ stateCode: "ia", species: "swine", evidenceReference: "IA state vet memo 2026-11" }),
    { stateCode: "IA", species: "Swine", evidenceReference: "IA state vet memo 2026-11" });
  assert.throws(() => normalizeActivationInput({ stateCode: "Iowa", species: "Swine", evidenceReference: "memo 123456" }), /two letters/);
  assert.throws(() => normalizeActivationInput({ stateCode: "IA", species: "Bovine", evidenceReference: "memo 123456" }), /groundwork/);
  assert.throws(() => normalizeActivationInput({ stateCode: "IA", species: "Swine", evidenceReference: "x" }), /evidence/);
  assert.throws(() => assertActivationApproval({ status: "PROPOSED", proposedById: "u1" }, "u1"), /proposer/);
  assert.throws(() => assertActivationApproval({ status: "ACTIVE", proposedById: "u1" }, "u2"), /Only a proposed/);
  assert.doesNotThrow(() => assertActivationApproval({ status: "PROPOSED", proposedById: "u1" }, "u2"));
});

test("both corridor endpoints must be active for the species", () => {
  const acts = [
    { stateCode: "IA", species: "Swine", status: "ACTIVE" as const },
    { stateCode: "MN", species: "Swine", status: "SUSPENDED" as const },
    { stateCode: "NE", species: "Swine", status: "PROPOSED" as const }
  ];
  assert.deepEqual(corridorJurisdictionsActive(acts, "IA", "IA", "swine"), { active: true });
  assert.equal(corridorJurisdictionsActive(acts, "IA", "MN", "Swine").active, false);
  assert.equal(corridorJurisdictionsActive(acts, "IA", "NE", "Swine").active, false);
  assert.equal(corridorJurisdictionsActive(acts, "IA", "IA", "Bovine").active, false);
});

test("procurement: separation of duties and dual approval above limit", () => {
  const policy = normalizeProcurementPolicy({ requirePurchaseOrder: true, singleApproverLimitUsd: 1000 });
  assert.equal(policy.singleApproverLimitCents, 100000);
  const small = { status: "REQUESTED" as const, amountCents: 50000, requestedById: "pi", firstApproverId: null, secondApproverId: null };
  assert.throws(() => approvePurchaseOrder(small, "pi", policy), /requester/);
  assert.equal(approvePurchaseOrder(small, "proc1", policy).status, "APPROVED");
  const large = { ...small, amountCents: 250000 };
  const first = approvePurchaseOrder(large, "proc1", policy);
  assert.equal(first.status, "PARTIALLY_APPROVED");
  assert.throws(() => approvePurchaseOrder({ ...large, ...first }, "proc1", policy), /different approver/);
  assert.equal(approvePurchaseOrder({ ...large, ...first }, "proc2", policy).status, "APPROVED");
  assert.throws(() => approvePurchaseOrder({ ...small, status: "APPROVED" }, "proc1", policy), /not awaiting/);
  assert.throws(() => normalizeProcurementPolicy({ requirePurchaseOrder: "yes", singleApproverLimitUsd: 1 }), /boolean/);
  assert.throws(() => normalizePurchaseOrderRequest({ poNumber: "x", costCenter: "CC" }), /PO number/);
});

test("buyer commitment procurement gate", () => {
  const policy = { requirePurchaseOrder: true, singleApproverLimitCents: 0 };
  assert.doesNotThrow(() => assertProcurementSatisfied(null, null, 100));
  assert.doesNotThrow(() => assertProcurementSatisfied({ requirePurchaseOrder: false, singleApproverLimitCents: 0 }, null, 100));
  assert.throws(() => assertProcurementSatisfied(policy, null, 100), /approved purchase order/);
  assert.throws(() => assertProcurementSatisfied(policy, { status: "PARTIALLY_APPROVED", amountCents: 100 }, 100), /approved purchase order/);
  assert.throws(() => assertProcurementSatisfied(policy, { status: "APPROVED", amountCents: 99 }, 100), /does not match/);
  assert.doesNotThrow(() => assertProcurementSatisfied(policy, { status: "APPROVED", amountCents: 100 }, 100));
});
