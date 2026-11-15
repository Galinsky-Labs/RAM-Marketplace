import assert from "node:assert/strict";
import test from "node:test";
import { buildStripeRequest, mapStripeEvent, signStripePayload, stripeAcknowledgment, stripeConfig, verifyStripeSignature } from "../lib/payments/stripe";
import { activePaymentRail } from "../lib/payments/rail";

const testKey = "sk_test_" + "a".repeat(24);
const whsec = "whsec_" + "b".repeat(32);
const base = { executionId: "ex1", settlementId: "st1", counterpartyOrganizationId: "org1", idempotencyKey: "ram-k1", amountCents: 12500, currency: "USD" };

test("Stripe is disabled without keys and refuses partial, malformed or unapproved live keys", () => {
  assert.equal(stripeConfig({}), null);
  assert.throws(() => stripeConfig({ RAM_STRIPE_SECRET_KEY: testKey }), /both/);
  assert.throws(() => stripeConfig({ RAM_STRIPE_SECRET_KEY: "pk_test_abc", RAM_STRIPE_WEBHOOK_SECRET: whsec }), /secret or restricted/);
  assert.throws(() => stripeConfig({ RAM_STRIPE_SECRET_KEY: "sk_live_" + "a".repeat(24), RAM_STRIPE_WEBHOOK_SECRET: whsec }), /ALLOW_LIVE/);
  assert.equal(stripeConfig({ RAM_STRIPE_SECRET_KEY: "sk_live_" + "a".repeat(24), RAM_STRIPE_WEBHOOK_SECRET: whsec, RAM_STRIPE_ALLOW_LIVE: "true" })?.live, true);
  assert.throws(() => stripeConfig({ RAM_STRIPE_SECRET_KEY: testKey, RAM_STRIPE_WEBHOOK_SECRET: whsec, RAM_STRIPE_API_BASE: "https://evil.test" }), /local test/);
  assert.equal(stripeConfig({ RAM_STRIPE_SECRET_KEY: testKey, RAM_STRIPE_WEBHOOK_SECRET: whsec })?.apiBase, "https://api.stripe.com");
});

test("exactly one payment rail may be active", () => {
  assert.equal(activePaymentRail({}), null);
  assert.equal(activePaymentRail({ RAM_STRIPE_SECRET_KEY: testKey, RAM_STRIPE_WEBHOOK_SECRET: whsec })?.kind, "stripe");
  assert.throws(() => activePaymentRail({
    RAM_STRIPE_SECRET_KEY: testKey, RAM_STRIPE_WEBHOOK_SECRET: whsec,
    RAM_PAYMENT_GATEWAY_NAME: "g", RAM_PAYMENT_GATEWAY_URL: "https://g.example.test", RAM_PAYMENT_GATEWAY_SECRET: "x".repeat(40)
  }), /not both/);
});

test("execution types map to PaymentIntent, Transfer and Refund with RAM metadata", () => {
  const pi = buildStripeRequest({ ...base, type: "BUYER_COLLECTION", accountReference: "cus_A1:pm_B2" });
  assert.equal(pi.path, "/v1/payment_intents");
  assert.equal(pi.params.get("customer"), "cus_A1");
  assert.equal(pi.params.get("currency"), "usd");
  assert.equal(pi.params.get("metadata[ram_execution_id]"), "ex1");
  const tr = buildStripeRequest({ ...base, type: "SUPPLIER_PAYOUT", accountReference: "acct_C3" });
  assert.equal(tr.path, "/v1/transfers");
  assert.equal(tr.params.get("destination"), "acct_C3");
  const re = buildStripeRequest({ ...base, type: "BUYER_REFUND", accountReference: "pi_D4" });
  assert.equal(re.path, "/v1/refunds");
  assert.throws(() => buildStripeRequest({ ...base, type: "SUPPLIER_PAYOUT", accountReference: "cus_A1" }), /acct_/);
  assert.throws(() => buildStripeRequest({ ...base, type: "BUYER_COLLECTION", accountReference: "cus_A1" }), /cus_/);
  assert.throws(() => buildStripeRequest({ ...base, amountCents: 0, type: "SUPPLIER_PAYOUT", accountReference: "acct_C3" }), /positive/);
});

test("acknowledgment requires the matching object type and execution metadata", () => {
  assert.equal(stripeAcknowledgment("BUYER_COLLECTION", { id: "pi_1", metadata: { ram_execution_id: "ex1" } }, "ex1").providerReference, "pi_1");
  assert.throws(() => stripeAcknowledgment("BUYER_COLLECTION", { id: "tr_1", metadata: { ram_execution_id: "ex1" } }, "ex1"), /unexpected/);
  assert.throws(() => stripeAcknowledgment("SUPPLIER_PAYOUT", { id: "tr_1", metadata: { ram_execution_id: "other" } }, "ex1"), /metadata/);
});

test("Stripe-Signature verification", () => {
  const body = JSON.stringify({ id: "evt_1" });
  const now = 1_763_200_000_000;
  const header = signStripePayload(body, now / 1000, whsec);
  assert.doesNotThrow(() => verifyStripeSignature(body, header, whsec, now));
  assert.doesNotThrow(() => verifyStripeSignature(body, header + ",v1=" + "0".repeat(64), whsec, now));
  assert.throws(() => verifyStripeSignature(body + " ", header, whsec, now), /Invalid Stripe signature/);
  assert.throws(() => verifyStripeSignature(body, header, whsec, now + 301_000), /tolerance/);
  assert.throws(() => verifyStripeSignature(body, "v1=abc", whsec, now), /Malformed/);
  assert.throws(() => verifyStripeSignature(body, null, whsec, now), /Missing/);
});

test("Stripe events map to provider-neutral statuses", () => {
  const event = (type: string, object: Record<string, unknown>) => ({ id: "evt_123456", type, created: 1_763_200_000, data: { object } });
  const meta = { ram_execution_id: "ex1" };
  const succeeded = mapStripeEvent(event("payment_intent.succeeded", { id: "pi_1", amount: 12500, currency: "usd", metadata: meta }));
  assert.deepEqual([succeeded?.status, succeeded?.type, succeeded?.currency, succeeded?.amountCents], ["SUCCEEDED", "BUYER_COLLECTION", "USD", 12500]);
  const failed = mapStripeEvent(event("payment_intent.payment_failed", { id: "pi_1", amount: 1, currency: "usd", metadata: meta, last_payment_error: { code: "card_declined" } }));
  assert.equal(failed?.failureCode, "card_declined");
  assert.equal(mapStripeEvent(event("transfer.created", { id: "tr_1", amount: 1, currency: "usd", metadata: meta }))?.status, "SUCCEEDED");
  assert.equal(mapStripeEvent(event("refund.updated", { id: "re_1", amount: 1, currency: "usd", status: "pending", metadata: meta }))?.status, "PROCESSING");
  assert.equal(mapStripeEvent(event("customer.created", { id: "cus_1", metadata: meta })), null);
  assert.equal(mapStripeEvent(event("payment_intent.succeeded", { id: "pi_1", amount: 1, currency: "usd" })), null, "not a RAM object");
  assert.throws(() => mapStripeEvent({ id: "x" }), /Invalid Stripe event/);
});
