/**
 * Live PostgreSQL E2E for RAM-05 scale features: multi-state jurisdiction
 * activation (two-person, groundwork species refused, suspension) and
 * institutional procurement (PO request, separation of duties, dual approval,
 * buyer-commit gate). Synthetic fixtures only.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const base = process.env.RAM_E2E_BASE_URL ?? "http://127.0.0.1:3118";
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

function fail(message: string): never {
  throw new Error("Scale E2E failed: " + message);
}
async function expectStatus(response: Response, status: number, label: string) {
  if (response.status !== status) fail(`${label}: expected ${status}, got ${response.status} ${await response.text()}`);
  return response;
}
async function demoCookie(actor: string) {
  const response = await fetch(base + "/api/session/demo", { method: "POST", headers: { Origin: base }, body: new URLSearchParams({ actor }), redirect: "manual" });
  await expectStatus(response, 303, actor + " login");
  return (response.headers.get("set-cookie") ?? "").split(";")[0];
}
function post(path: string, cookie: string, body: Record<string, unknown>) {
  return fetch(base + path, { method: "POST", headers: { Origin: base, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function fixtureOrder(suffix: string, priceCents: number) {
  const animalId = "RAM-SW-SCALE" + suffix;
  await prisma.animalCase.create({ data: { publicId: animalId, species: "Swine", condition: "Synthetic scale fixture", regionLabel: "Midwest", publicSummary: "Synthetic", status: "RESERVED" } });
  const need = await prisma.researchNeed.create({ data: {
    organizationId: "demo-research-organization", createdByUserId: "demo-scientist-user", title: "Scale fixture " + suffix,
    condition: "Synthetic scale fixture", requiredPhenotype: "Synthetic phenotype text", timeline: "Q1", protocolStatus: "APPROVED",
    scientificRationale: "Synthetic", status: "SELECTED"
  } });
  return prisma.order.create({ data: {
    animalCaseId: animalId, buyerOrganizationId: "demo-research-organization", researchNeedId: need.id, createdByUserId: "demo-scientist-user",
    status: "CHECKOUT_PENDING", buyerPriceCents: priceCents, quoteExpiresAt: new Date(Date.now() + 86_400_000), holdExpiresAt: new Date(Date.now() + 86_400_000)
  } });
}
function commit(cookie: string, orderId: string) {
  return fetch(base + "/api/orders/" + orderId + "/commit", {
    method: "POST", headers: { Origin: base, Cookie: cookie }, redirect: "manual",
    body: new URLSearchParams({ receivingFacilityName: "Synthetic Lab", receivingFacilityAddress: "100 Research Way, Test City",
      protocolReference: "IACUC-SYN-1", institutionalApprovalAttested: "on", purchasingAuthorityAttested: "on" })
  });
}

try {
  const compliance = await demoCookie("compliance");
  const ram = await demoCookie("ram");
  const scientist = await demoCookie("scientist");
  const procurement = await demoCookie("procurement");

  // Multi-state activation.
  const J = "/api/ops/compliance/jurisdictions";
  await expectStatus(await post(J, scientist, { action: "PROPOSE", stateCode: "IA", species: "Swine", evidenceReference: "CI synthetic memo 0001" }), 403, "non-RAM cannot propose");
  await expectStatus(await post(J, compliance, { action: "PROPOSE", stateCode: "IA", species: "Bovine", evidenceReference: "CI synthetic memo 0001" }), 400, "groundwork species refused");
  const proposed = await (await expectStatus(await post(J, compliance, { action: "PROPOSE", stateCode: "ia", species: "swine", evidenceReference: "CI synthetic memo 0001" }), 200, "propose IA swine")).json();
  const id = proposed.jurisdiction.id as string;
  await expectStatus(await post(J, compliance, { action: "APPROVE", id }), 403, "proposer cannot approve");
  const approved = await (await expectStatus(await post(J, ram, { action: "APPROVE", id }), 200, "second reviewer approves")).json();
  if (approved.jurisdiction.status !== "ACTIVE" || approved.jurisdiction.stateCode !== "IA") fail("activation not ACTIVE");
  await expectStatus(await post(J, compliance, { action: "PROPOSE", stateCode: "IA", species: "Swine", evidenceReference: "CI synthetic memo 0002" }), 409, "active jurisdiction cannot be re-proposed");
  const suspended = await (await expectStatus(await post(J, compliance, { action: "SUSPEND", id, reason: "CI outbreak-stop drill" }), 200, "suspend")).json();
  if (suspended.jurisdiction.status !== "SUSPENDED") fail("suspension not applied");
  if (await prisma.auditEvent.count({ where: { entityType: "JurisdictionActivation", entityId: id } }) < 3) fail("activation audit trail missing");

  // Procurement.
  const P = "/api/research/procurement";
  await expectStatus(await post(P, scientist, { action: "POLICY", requirePurchaseOrder: true, singleApproverLimitUsd: 1000 }), 403, "PI cannot set policy");
  await expectStatus(await post(P, procurement, { action: "POLICY", requirePurchaseOrder: true, singleApproverLimitUsd: 1000 }), 200, "procurement sets policy");
  const small = await fixtureOrder("A1", 50_000);
  await expectStatus(await commit(procurement, small.id), 400, "commit blocked without PO");
  await expectStatus(await post(P, scientist, { action: "REQUEST", orderId: small.id, poNumber: "PO-CI-0001", costCenter: "CC-100" }), 200, "PI requests PO");
  await expectStatus(await post(P, scientist, { action: "APPROVE", orderId: small.id }), 403, "PI cannot approve");
  await expectStatus(await commit(procurement, small.id), 400, "commit blocked while PO pending");
  const smallPo = await (await expectStatus(await post(P, procurement, { action: "APPROVE", orderId: small.id }), 200, "procurement approves")).json();
  if (smallPo.result.status !== "APPROVED") fail("small PO should be approved by one approver");
  await expectStatus(await commit(procurement, small.id), 303, "commit allowed with approved PO");

  const large = await fixtureOrder("B2", 250_000);
  await expectStatus(await post(P, scientist, { action: "REQUEST", orderId: large.id, poNumber: "PO-CI-0002", costCenter: "CC-100" }), 200, "PI requests large PO");
  const partial = await (await expectStatus(await post(P, procurement, { action: "APPROVE", orderId: large.id }), 200, "first approval")).json();
  if (partial.result.status !== "PARTIALLY_APPROVED") fail("large PO needs dual approval");
  await expectStatus(await post(P, procurement, { action: "APPROVE", orderId: large.id }), 403, "same approver cannot approve twice");
  await expectStatus(await commit(procurement, large.id), 400, "commit blocked with partial approval");

  // Reset policy so later suites see the default buyer flow.
  await expectStatus(await post(P, procurement, { action: "POLICY", requirePurchaseOrder: false, singleApproverLimitUsd: 0 }), 200, "reset policy");
  console.log("RAM scale E2E passed: two-person jurisdiction activation, groundwork species refusal, suspension, PO separation of duties, dual approval and buyer-commit gate.");
} finally {
  await prisma.$disconnect();
}
