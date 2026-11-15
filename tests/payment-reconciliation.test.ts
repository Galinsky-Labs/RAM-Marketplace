import assert from "node:assert/strict";
import test from "node:test";
import { reconcilePayments, statementSchema, type ExecutionRecord, type StatementLine } from "../lib/payment-reconciliation";

const exec = (over: Partial<ExecutionRecord> = {}): ExecutionRecord => ({
  id: "ex1", idempotencyKey: "k1", providerReference: "pi_1", amountCents: 1000, currency: "USD", status: "SUCCEEDED", type: "BUYER_COLLECTION", ...over
});
const line = (over: Partial<StatementLine> = {}): StatementLine => ({
  providerReference: "pi_1", amountCents: 1000, currency: "USD", status: "SUCCEEDED", occurredAt: "2026-11-02T00:00:00Z", ...over
});

test("matching statement reconciles", () => {
  const r = reconcilePayments([exec()], [line()]);
  assert.equal(r.reconciled, true);
  assert.equal(r.matched, 1);
});

test("amount, currency and status mismatches are reported", () => {
  const r = reconcilePayments([exec()], [line({ amountCents: 999, currency: "CAD", status: "FAILED" })]);
  assert.deepEqual(r.discrepancies.map((d) => d.kind).sort(), ["AMOUNT_MISMATCH", "CURRENCY_MISMATCH", "STATUS_MISMATCH"]);
  assert.equal(r.reconciled, false);
});

test("missing, unknown and duplicate lines are reported", () => {
  const missing = reconcilePayments([exec()], []);
  assert.equal(missing.discrepancies[0].kind, "MISSING_AT_PROVIDER");
  const unknown = reconcilePayments([], [line()]);
  assert.equal(unknown.discrepancies[0].kind, "UNKNOWN_AT_RAM");
  const dup = reconcilePayments([exec()], [line(), line()]);
  assert.ok(dup.discrepancies.some((d) => d.kind === "DUPLICATE_PROVIDER_LINE"));
  assert.equal(dup.reconciled, false);
});

test("lines can match by idempotency key when the provider reference was never recorded", () => {
  const r = reconcilePayments([exec({ providerReference: null, status: "SUBMISSION_UNKNOWN" })], [line({ idempotencyKey: "k1" })]);
  assert.equal(r.matched, 1);
  assert.equal(r.discrepancies.length, 0);
});

test("never-submitted executions are ignored; failed executions with no line are fine", () => {
  const r = reconcilePayments([exec({ status: "CREATED", providerReference: null }), exec({ id: "ex2", idempotencyKey: "k2", providerReference: null, status: "FAILED" })], []);
  assert.equal(r.reconciled, true);
});

test("statement schema enforces period order and strict lines", () => {
  assert.equal(statementSchema.safeParse({ provider: "stripe", periodStart: "2026-12-01", periodEnd: "2026-11-01", lines: [] }).success, false);
  assert.equal(statementSchema.safeParse({ provider: "stripe", periodStart: "2026-11-01", periodEnd: "2026-12-01", lines: [{ ...line(), extra: 1 }] }).success, false);
  assert.equal(statementSchema.safeParse({ provider: "stripe", periodStart: "2026-11-01", periodEnd: "2026-12-01", lines: [line()] }).success, true);
});
