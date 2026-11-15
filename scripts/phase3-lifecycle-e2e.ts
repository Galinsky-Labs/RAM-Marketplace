/**
 * Live PostgreSQL E2E for Phase 3 pilot integrations: producer data feed
 * (CSV via enterprise API key) -> quarantine -> RAM verification/promotion,
 * signed diagnostic lab results -> veterinary acknowledgement, and provider
 * statement reconciliation. Synthetic fixtures only.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { signDiagnosticsPayload } from "../lib/diagnostics";

const base = process.env.RAM_E2E_BASE_URL ?? "http://127.0.0.1:3118";
const databaseUrl = process.env.DATABASE_URL;
const diagnosticsSecret = process.env.RAM_DIAGNOSTICS_WEBHOOK_SECRET;
if (!databaseUrl || !diagnosticsSecret) throw new Error("DATABASE_URL and RAM_DIAGNOSTICS_WEBHOOK_SECRET are required");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

function fail(message: string): never {
  throw new Error("Phase 3 E2E failed: " + message);
}
async function expectStatus(response: Response, status: number, label: string) {
  if (response.status !== status) fail(`${label}: expected HTTP ${status}, got ${response.status} ${await response.text()}`);
}
async function demoCookie(actor: string) {
  const response = await fetch(base + "/api/session/demo", {
    method: "POST", headers: { Origin: base }, body: new URLSearchParams({ actor }), redirect: "manual"
  });
  await expectStatus(response, 303, actor + " demo login");
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie.startsWith("ram_session=")) fail("no session cookie for " + actor);
  return cookie;
}

try {
  const farmer = await demoCookie("farmer");
  const ops = await demoCookie("ram");
  const vet = await demoCookie("veterinarian");
  const finance = await demoCookie("finance");

  // Producer data feed via API key + CSV.
  const keyResponse = await fetch(base + "/api/farm/api-keys", {
    method: "POST", headers: { Origin: base, Cookie: farmer, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "ci-phase3-feed", scopes: ["supplier-batch:write"], ttlDays: 1 })
  });
  await expectStatus(keyResponse, 201, "create feed API key");
  const token = (await keyResponse.json()).key.token as string;
  const csv = [
    "externalAnimalId,species,sex,condition,observedSigns,cullDecisionDate,plannedCullAt,cullReason,welfareUrgency,independentCullAttestation,ownerAttestation",
    'CI-SOW-1,Swine,Female,Chronic lameness,"Intermittent lameness, left hind",2026-11-01,2026-11-20,Culled for chronic lameness,ROUTINE,yes,yes',
    "CI-SOW-2,Swine,Female,Rectal prolapse,Recurrent rectal prolapse observed,2026-11-02,2026-11-21,Culled for recurrent prolapse,SOON,yes,yes"
  ].join("\n");
  const importResponse = await fetch(base + "/api/farm/batch/import?batchKey=ci-phase3-csv-0001", {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "text/csv" }, body: csv
  });
  await expectStatus(importResponse, 201, "CSV feed quarantined");
  const imported = await importResponse.json();
  if (imported.candidatesCreated !== 0) fail("quarantine must not create candidates");
  const replay = await fetch(base + "/api/farm/batch/import?batchKey=ci-phase3-csv-0001", {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "text/csv" }, body: csv
  });
  await expectStatus(replay, 200, "identical feed replay is idempotent");

  await expectStatus(await fetch(base + "/api/ops/producer-feeds", {
    method: "POST", headers: { Origin: base, Cookie: farmer, "Content-Type": "application/json" },
    body: JSON.stringify({ id: imported.id, action: "PROMOTE", note: "self promotion attempt" })
  }), 403, "supplier cannot promote own feed");
  const promote = await fetch(base + "/api/ops/producer-feeds", {
    method: "POST", headers: { Origin: base, Cookie: ops, "Content-Type": "application/json" },
    body: JSON.stringify({ id: imported.id, action: "PROMOTE", note: "CI verification of synthetic feed" })
  });
  await expectStatus(promote, 200, "RAM ops promotes feed");
  const caseIds = (await promote.json()).result.caseIds as string[];
  if (caseIds.length !== 2) fail("promotion must create one case per row");
  const cases = await prisma.animalCase.findMany({ where: { publicId: { in: caseIds } } });
  if (cases.length !== 2 || cases.some((c) => c.status !== "SUBMITTED")) fail("promoted cases must be SUBMITTED only");
  await expectStatus(await fetch(base + "/api/ops/producer-feeds", {
    method: "POST", headers: { Origin: base, Cookie: ops, "Content-Type": "application/json" },
    body: JSON.stringify({ id: imported.id, action: "PROMOTE", note: "second promotion attempt" })
  }), 409, "batch cannot be promoted twice");

  // Signed diagnostic laboratory result.
  const report = JSON.stringify({
    externalReportId: "CI-LAB-0001", animalCaseId: caseIds[0], testCode: "RADIOGRAPH", testName: "Hind limb radiograph",
    reportedAt: new Date().toISOString(), resultStatus: "FINAL", interpretation: "ABNORMAL", narrative: "Synthetic CI result"
  });
  async function sendReport(body: string, signature?: string) {
    const ts = String(Math.floor(Date.now() / 1000));
    return fetch(base + "/api/diagnostics/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ram-diagnostics-timestamp": ts,
        "x-ram-diagnostics-signature": signature ?? signDiagnosticsPayload(body, ts, diagnosticsSecret!) },
      body
    });
  }
  await expectStatus(await sendReport(report, "0".repeat(64)), 401, "unsigned lab report rejected");
  const first = await sendReport(report);
  await expectStatus(first, 201, "signed lab report accepted");
  const firstBody = await first.json();
  if (firstBody.statusChanged !== false || firstBody.reviewFlag !== "VET_REVIEW_REQUIRED") fail("lab report must only flag for review");
  await expectStatus(await sendReport(report), 200, "lab report replay idempotent");
  await expectStatus(await sendReport(report.replace("Synthetic CI result", "Altered")), 409, "lab report id reuse with new content rejected");
  const unchanged = await prisma.animalCase.findUnique({ where: { publicId: caseIds[0] } });
  if (unchanged?.status !== "SUBMITTED") fail("lab report must not change case status");
  await expectStatus(await fetch(base + "/api/vet/diagnostics", {
    method: "POST", headers: { Origin: base, Cookie: farmer }, body: new URLSearchParams({ id: firstBody.id, note: "not a vet" }), redirect: "manual"
  }), 403, "non-vet cannot acknowledge");
  await expectStatus(await fetch(base + "/api/vet/diagnostics", {
    method: "POST", headers: { Origin: base, Cookie: vet }, body: new URLSearchParams({ id: firstBody.id, note: "Reviewed radiograph; schedule exam" }), redirect: "manual"
  }), 303, "vet acknowledges lab report");

  // Payment reconciliation.
  const statement = {
    provider: "ci-gateway", periodStart: "2020-01-01T00:00:00Z", periodEnd: "2020-02-01T00:00:00Z",
    lines: [{ providerReference: "ci-unknown-1", amountCents: 500, currency: "USD", status: "SUCCEEDED", occurredAt: "2020-01-10T00:00:00Z" }]
  };
  async function reconcile(cookie: string) {
    return fetch(base + "/api/finance/reconciliation", {
      method: "POST", headers: { Origin: base, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(statement)
    });
  }
  await expectStatus(await reconcile(farmer), 403, "non-finance cannot reconcile");
  const run = await reconcile(finance);
  await expectStatus(run, 201, "finance reconciliation run");
  const runBody = await run.json();
  if (runBody.run.reconciled !== false || runBody.run.discrepancyCount !== 1) fail("unknown provider line must be a discrepancy");
  await expectStatus(await reconcile(finance), 200, "identical statement replay");

  console.log("RAM Phase 3 E2E passed: CSV producer feed via API key, quarantine, RAM promotion, signed lab results, vet acknowledgement and payment reconciliation.");
} finally {
  await prisma.$disconnect();
}
