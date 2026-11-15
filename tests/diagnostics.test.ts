import assert from "node:assert/strict";
import test from "node:test";
import {
  diagnosticReviewFlag, diagnosticsConfig, parseDiagnosticReport,
  signDiagnosticsPayload, verifyDiagnosticsSignature
} from "../lib/diagnostics";

const secret = "lab-webhook-secret-" + "x".repeat(32);
const report = {
  externalReportId: "LAB-2026-000123", animalCaseId: "RAM-SW-ABCDEF1234", testCode: "PRRSV-PCR",
  testName: "PRRSV RT-PCR", reportedAt: "2026-11-14T12:00:00Z", resultStatus: "FINAL", interpretation: "DETECTED",
  observations: [{ code: "CT", name: "Cycle threshold", value: "24.1", flag: "A" }]
};

test("config is disabled without both values and rejects weak or reused secrets", () => {
  assert.equal(diagnosticsConfig({}), null);
  assert.equal(diagnosticsConfig({ RAM_DIAGNOSTICS_PROVIDER_NAME: "lab" }), null);
  assert.throws(() => diagnosticsConfig({ RAM_DIAGNOSTICS_PROVIDER_NAME: "lab", RAM_DIAGNOSTICS_WEBHOOK_SECRET: "short" }), /strong/);
  assert.throws(() => diagnosticsConfig({ RAM_DIAGNOSTICS_PROVIDER_NAME: "lab", RAM_DIAGNOSTICS_WEBHOOK_SECRET: secret, AUTH_SECRET: secret }), /distinct/);
  assert.throws(() => diagnosticsConfig({ RAM_DIAGNOSTICS_PROVIDER_NAME: "Lab Name", RAM_DIAGNOSTICS_WEBHOOK_SECRET: secret }), /invalid/);
  assert.deepEqual(diagnosticsConfig({ RAM_DIAGNOSTICS_PROVIDER_NAME: "state-lab", RAM_DIAGNOSTICS_WEBHOOK_SECRET: secret }), { provider: "state-lab", secret });
});

test("signatures verify, and tampering, skew and malformed headers fail", () => {
  const body = JSON.stringify(report);
  const now = 1_763_200_000_000;
  const ts = String(now / 1000);
  const sig = signDiagnosticsPayload(body, ts, secret);
  assert.doesNotThrow(() => verifyDiagnosticsSignature(body, ts, sig, secret, now));
  assert.throws(() => verifyDiagnosticsSignature(body + " ", ts, sig, secret, now), /Invalid diagnostics signature/);
  assert.throws(() => verifyDiagnosticsSignature(body, String(now / 1000 - 301), signDiagnosticsPayload(body, String(now / 1000 - 301), secret), secret, now), /skew/);
  assert.throws(() => verifyDiagnosticsSignature(body, ts, sig.slice(0, 63), secret, now), /Invalid/);
  assert.throws(() => verifyDiagnosticsSignature(body, null, sig, secret, now), /required/);
  assert.throws(() => verifyDiagnosticsSignature(body, "1e9", sig, secret, now), /timestamp/);
});

test("reports are strictly validated", () => {
  const { report: parsed, payloadHash } = parseDiagnosticReport(JSON.stringify(report));
  assert.equal(parsed.reportable, false);
  assert.match(payloadHash, /^[a-f0-9]{64}$/);
  assert.throws(() => parseDiagnosticReport(JSON.stringify({ ...report, eligible: true })), /Invalid diagnostic report/);
  assert.throws(() => parseDiagnosticReport(JSON.stringify({ ...report, interpretation: "POSITIVE" })), /interpretation/);
  assert.throws(() => parseDiagnosticReport("{"), /JSON/);
});

test("review flags escalate but never clear", () => {
  assert.equal(diagnosticReviewFlag({ reportable: true, interpretation: "NOT_DETECTED", resultStatus: "FINAL" }), "REPORTABLE_CONDITION_STOP");
  assert.equal(diagnosticReviewFlag({ reportable: false, interpretation: "DETECTED", resultStatus: "FINAL" }), "VET_REVIEW_REQUIRED");
  assert.equal(diagnosticReviewFlag({ reportable: false, interpretation: "NORMAL", resultStatus: "FINAL" }), "INFORMATIONAL");
  assert.equal(diagnosticReviewFlag({ reportable: false, interpretation: "NORMAL", resultStatus: "CANCELLED" }), "CANCELLED");
});
