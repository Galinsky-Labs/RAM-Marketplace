/**
 * Live E2E for the Stripe adapter against scripts/fake-stripe-api.mjs.
 * Requires an app server started with RAM_STRIPE_* (and no RAM_PAYMENT_GATEWAY_*)
 * at RAM_STRIPE_E2E_BASE_URL. Webhooks are signed exactly like Stripe's
 * (Stripe-Signature: t=..., v1=HMAC-SHA256("t.payload", whsec)).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { signStripePayload } from "../lib/payments/stripe";

const base = process.env.RAM_STRIPE_E2E_BASE_URL ?? "http://127.0.0.1:3119";
const fakeStripe = "http://127.0.0.1:" + (process.env.RAM_FAKE_STRIPE_PORT ?? "4122");
const whsec = process.env.RAM_STRIPE_WEBHOOK_SECRET!;
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

function fail(message: string): never {
  throw new Error("Stripe E2E failed: " + message);
}
async function login(actor: string) {
  const response = await fetch(base + "/api/session/demo", { method: "POST", headers: { Origin: base }, body: new URLSearchParams({ actor }), redirect: "manual" });
  if (response.status !== 303) fail("login " + actor);
  return (response.headers.get("set-cookie") ?? "").split(";")[0];
}
function execute(cookie: string, settlementId: string, type: string, amountUsd: string) {
  return fetch(base + "/api/finance/settlements/" + settlementId + "/execute", {
    method: "POST", headers: { Origin: base, Cookie: cookie }, redirect: "manual", body: new URLSearchParams({ type, amountUsd })
  });
}
async function stripeEvent(type: string, object: Record<string, unknown>, signatureOverride?: string) {
  const payload = JSON.stringify({
    id: "evt_" + Math.random().toString(36).slice(2, 14), object: "event", api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000), livemode: false, pending_webhooks: 1, type, data: { object }
  });
  return fetch(base + "/api/payments/stripe/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signatureOverride ?? signStripePayload(payload, Math.floor(Date.now() / 1000), whsec) },
    body: payload
  });
}
async function lastRequest(path: string) {
  const { requests } = await (await fetch(fakeStripe + "/__requests")).json() as { requests: { path: string; idempotencyKey: string; stripeVersion: string; params: Record<string, string> }[] };
  return requests.filter((r) => r.path === path).at(-1);
}
async function settlement(buyerCents: number, supplierCents: number) {
  const animal = await prisma.animalCase.findFirst({
    where: { sourceRecord: { farmSite: { organizationId: "demo-farm-organization" } } },
    orderBy: { createdAt: "asc" }
  });
  const need = await prisma.researchNeed.findFirst({ orderBy: { createdAt: "asc" } });
  if (!animal || !need) fail("seed records missing");
  const order = await prisma.order.create({ data: {
    animalCaseId: animal.publicId, researchNeedId: need.id, buyerOrganizationId: "demo-research-organization", createdByUserId: "demo-scientist-user",
    status: "ACCEPTED", buyerPriceCents: buyerCents, supplierScheduleCents: supplierCents, supplierMarketCeilingCents: supplierCents,
    supplierAcquisitionCents: supplierCents, directCostsCents: 0, buyerCommittedAt: new Date(), acquisitionCommittedAt: new Date()
  } });
  return prisma.financialSettlement.create({ data: {
    orderId: order.id, status: "OPEN", buyerReceivableCents: buyerCents, supplierPayableCents: supplierCents,
    supplierScheduleCents: supplierCents, supplierMarketCeilingCents: supplierCents, directCostsCents: 0, grossSpreadCents: buyerCents - supplierCents,
    entries: { create: [
      { type: "BUYER_RECEIVABLE", amountCents: buyerCents, recordedByUserId: "demo-finance-user" },
      { type: "SUPPLIER_PAYABLE", amountCents: supplierCents, recordedByUserId: "demo-finance-user" }
    ] }
  } });
}

const savedProfiles = await prisma.organizationPaymentProfile.findMany({ where: { organizationId: { in: ["demo-research-organization", "demo-farm-organization"] } } });
try {
  await prisma.organizationPaymentProfile.update({ where: { organizationId: "demo-research-organization" }, data: { gateway: "stripe", externalAccountReference: "cus_CiBuyer01:pm_card_visa", status: "ACTIVE" } });
  await prisma.organizationPaymentProfile.update({ where: { organizationId: "demo-farm-organization" }, data: { gateway: "stripe", externalAccountReference: "acct_CiSupplier01", status: "ACTIVE" } });
  const finance = await login("finance");
  const s1 = await settlement(10_000, 2_000);

  // Buyer collection -> PaymentIntent.
  const collect = await execute(finance, s1.id, "BUYER_COLLECTION", "100");
  if (collect.status !== 303) fail("collection initiation " + collect.status + " " + await collect.text());
  const pi = await prisma.paymentExecution.findFirst({ where: { settlementId: s1.id, type: "BUYER_COLLECTION" } });
  if (!pi || pi.status !== "PROCESSING" || !pi.providerReference?.startsWith("pi_") || pi.gateway !== "stripe") fail("PaymentIntent acknowledgment not recorded");
  const piReq = await lastRequest("/v1/payment_intents");
  if (!piReq || piReq.idempotencyKey !== pi.idempotencyKey || piReq.params.amount !== "10000" || piReq.params.currency !== "usd" ||
      piReq.params.customer !== "cus_CiBuyer01" || piReq.params.payment_method !== "pm_card_visa" || piReq.params.confirm !== "true" ||
      piReq.params["metadata[ram_execution_id]"] !== pi.id || !piReq.stripeVersion) fail("PaymentIntent request shape mismatch");

  const piObject = { id: pi.providerReference, object: "payment_intent", amount: 10_000, amount_received: 10_000, currency: "usd", status: "succeeded", metadata: { ram_execution_id: pi.id } };
  if ((await stripeEvent("payment_intent.succeeded", piObject, "t=1,v1=" + "0".repeat(64))).status !== 401) fail("bad Stripe signature accepted");
  const ok = await stripeEvent("payment_intent.succeeded", piObject);
  if (ok.status !== 200) fail("succeeded webhook " + ok.status + " " + await ok.text());
  const paid = await prisma.paymentExecution.findUnique({ where: { id: pi.id } });
  if (paid?.status !== "SUCCEEDED" || !paid.ledgerEntryId) fail("collection not settled into ledger");
  const ignored = await (await stripeEvent("charge.updated", { id: "ch_1", object: "charge", metadata: {} })).json();
  if (!ignored.ignored) fail("unrelated events must be acknowledged and ignored");
  const mismatch = await stripeEvent("payment_intent.succeeded", { ...piObject, amount: 9_999 });
  if (mismatch.status !== 409) fail("amount-mismatched event must be rejected, got " + mismatch.status);
  if (await prisma.financialLedgerEntry.count({ where: { settlementId: s1.id, type: "BUYER_PAYMENT" } }) !== 1) fail("ledger must hold exactly one buyer payment");

  // Supplier payout -> Connect transfer.
  const payout = await execute(finance, s1.id, "SUPPLIER_PAYOUT", "20");
  if (payout.status !== 303) fail("payout initiation " + payout.status + " " + await payout.text());
  const tr = await prisma.paymentExecution.findFirst({ where: { settlementId: s1.id, type: "SUPPLIER_PAYOUT" } });
  const trReq = await lastRequest("/v1/transfers");
  if (!tr?.providerReference?.startsWith("tr_") || trReq?.params.destination !== "acct_CiSupplier01" || trReq.params.amount !== "2000") fail("transfer request/ack mismatch");
  const trDone = await stripeEvent("transfer.created", { id: tr.providerReference, object: "transfer", amount: 2_000, currency: "usd", metadata: { ram_execution_id: tr.id } });
  if (trDone.status !== 200 || (await prisma.paymentExecution.findUnique({ where: { id: tr.id } }))?.status !== "SUCCEEDED") fail("transfer not settled");

  // Declined card -> FAILED with Stripe's decline code; nothing posted to the ledger.
  await prisma.organizationPaymentProfile.update({ where: { organizationId: "demo-research-organization" }, data: { externalAccountReference: "cus_CiBuyer01:pm_card_chargeDeclined" } });
  const s2 = await settlement(5_000, 1_000);
  const declined = await execute(finance, s2.id, "BUYER_COLLECTION", "50");
  if (declined.status !== 400) fail("declined card should be rejected, got " + declined.status);
  const failed = await prisma.paymentExecution.findFirst({ where: { settlementId: s2.id } });
  if (failed?.status !== "FAILED" || failed.failureCode !== "card_declined") fail("decline not recorded");
  if (await prisma.financialLedgerEntry.count({ where: { settlementId: s2.id, type: "BUYER_PAYMENT" } }) !== 0) fail("declined payment posted to ledger");

  console.log("RAM Stripe E2E passed: PaymentIntent and Connect transfer requests, idempotency keys, signed webhook settlement, signature rejection, ignored events and card decline.");
} finally {
  for (const profile of savedProfiles) {
    await prisma.organizationPaymentProfile.update({ where: { id: profile.id }, data: { gateway: profile.gateway, externalAccountReference: profile.externalAccountReference, status: profile.status } });
  }
  await prisma.$disconnect();
}
