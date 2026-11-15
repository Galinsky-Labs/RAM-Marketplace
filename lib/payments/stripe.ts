import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  PaymentExecutionType,
  PaymentGatewayAcknowledgment,
  PaymentGatewayInstruction
} from "./gateway";

/**
 * Stripe adapter behind the provider-neutral payment rail. Disabled unless
 * RAM_STRIPE_SECRET_KEY and RAM_STRIPE_WEBHOOK_SECRET are configured. Live
 * keys additionally require RAM_STRIPE_ALLOW_LIVE=true (an explicit owner
 * decision); the public demo never configures Stripe.
 *
 * Account references on organization payment profiles:
 *   BUYER_COLLECTION  "cus_...:pm_..."  (customer with a saved payment method)
 *   SUPPLIER_PAYOUT   "acct_..."        (Stripe Connect connected account)
 *   BUYER_REFUND      "pi_..."          (the original PaymentIntent to refund)
 */
export const STRIPE_GATEWAY_NAME = "stripe";
export const STRIPE_API_BASE = "https://api.stripe.com";

export interface StripeConfig {
  name: typeof STRIPE_GATEWAY_NAME;
  secretKey: string;
  webhookSecret: string;
  live: boolean;
  apiBase: string;
}

export function stripeConfig(env: Record<string, string | undefined> = process.env): StripeConfig | null {
  const secretKey = env.RAM_STRIPE_SECRET_KEY?.trim();
  const webhookSecret = env.RAM_STRIPE_WEBHOOK_SECRET?.trim();
  if (!secretKey && !webhookSecret) return null;
  if (!secretKey || !webhookSecret) {
    throw new Error("Stripe requires both RAM_STRIPE_SECRET_KEY and RAM_STRIPE_WEBHOOK_SECRET");
  }
  const match = /^(sk|rk)_(test|live)_[A-Za-z0-9]{16,}$/.exec(secretKey);
  if (!match) throw new Error("RAM_STRIPE_SECRET_KEY is not a Stripe secret or restricted key");
  if (!/^whsec_[A-Za-z0-9+/=]{16,}$/.test(webhookSecret)) {
    throw new Error("RAM_STRIPE_WEBHOOK_SECRET is not a Stripe webhook signing secret");
  }
  const live = match[2] === "live";
  if (live && env.RAM_STRIPE_ALLOW_LIVE !== "true") {
    throw new Error("Live Stripe keys require RAM_STRIPE_ALLOW_LIVE=true (owner approval)");
  }
  // Test-only override so E2E can target a local fake; never honored for live keys.
  const override = env.RAM_STRIPE_API_BASE?.trim();
  let apiBase = STRIPE_API_BASE;
  if (override) {
    const url = new URL(override);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (live || !loopback) throw new Error("RAM_STRIPE_API_BASE may only point to a local test server");
    apiBase = url.origin;
  }
  return { name: STRIPE_GATEWAY_NAME, secretKey, webhookSecret, live, apiBase };
}

export interface StripeRequest {
  path: string;
  params: URLSearchParams;
}

function metadata(params: URLSearchParams, instruction: PaymentGatewayInstruction) {
  params.set("metadata[ram_execution_id]", instruction.executionId);
  params.set("metadata[ram_settlement_id]", instruction.settlementId);
  params.set("metadata[ram_idempotency_key]", instruction.idempotencyKey);
}

/** Map a RAM execution instruction to a single Stripe API call. */
export function buildStripeRequest(instruction: PaymentGatewayInstruction): StripeRequest {
  if (!Number.isInteger(instruction.amountCents) || instruction.amountCents <= 0) {
    throw new Error("Stripe amount must be a positive integer number of cents");
  }
  if (!/^[A-Z]{3}$/.test(instruction.currency)) throw new Error("Invalid currency");
  const params = new URLSearchParams();
  const currency = instruction.currency.toLowerCase();
  const ref = instruction.accountReference;
  switch (instruction.type) {
    case "BUYER_COLLECTION": {
      const match = /^(cus_[A-Za-z0-9]+):(pm_[A-Za-z0-9]+)$/.exec(ref);
      if (!match) throw new Error("Buyer collection requires a 'cus_...:pm_...' account reference");
      params.set("amount", String(instruction.amountCents));
      params.set("currency", currency);
      params.set("customer", match[1]);
      params.set("payment_method", match[2]);
      params.set("confirm", "true");
      params.set("off_session", "true");
      params.set("description", "RAM Marketplace settlement " + instruction.settlementId);
      metadata(params, instruction);
      return { path: "/v1/payment_intents", params };
    }
    case "SUPPLIER_PAYOUT": {
      if (!/^acct_[A-Za-z0-9]+$/.test(ref)) throw new Error("Supplier payout requires an 'acct_...' connected account");
      params.set("amount", String(instruction.amountCents));
      params.set("currency", currency);
      params.set("destination", ref);
      params.set("transfer_group", "ram_" + instruction.settlementId);
      metadata(params, instruction);
      return { path: "/v1/transfers", params };
    }
    case "BUYER_REFUND": {
      if (!/^pi_[A-Za-z0-9]+$/.test(ref)) throw new Error("Buyer refund requires the original 'pi_...' reference");
      params.set("payment_intent", ref);
      params.set("amount", String(instruction.amountCents));
      metadata(params, instruction);
      return { path: "/v1/refunds", params };
    }
    default:
      throw new Error("Unsupported execution type");
  }
}

const prefixByType: Record<PaymentExecutionType, string> = {
  BUYER_COLLECTION: "pi_",
  SUPPLIER_PAYOUT: "tr_",
  BUYER_REFUND: "re_"
};

/** Translate the Stripe object returned by a successful create call. */
export function stripeAcknowledgment(type: PaymentExecutionType, body: unknown, executionId: string): PaymentGatewayAcknowledgment {
  if (!body || typeof body !== "object") throw new Error("Stripe returned an invalid object");
  const record = body as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "string" || !id.startsWith(prefixByType[type])) {
    throw new Error("Stripe returned an unexpected object type");
  }
  const meta = record.metadata as Record<string, unknown> | undefined;
  if (!meta || meta.ram_execution_id !== executionId) {
    throw new Error("Stripe object metadata does not match the execution");
  }
  return { gateway: STRIPE_GATEWAY_NAME, provider: STRIPE_GATEWAY_NAME, providerReference: id, status: "PROCESSING" };
}

/** Verify a Stripe-Signature header ("t=...,v1=...") per Stripe's scheme. */
export function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  webhookSecret: string,
  nowMs = Date.now(),
  toleranceSeconds = 300
): void {
  if (!header) throw new Error("Missing Stripe signature");
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key === "t") timestamp = value ?? null;
    else if (key === "v1" && value) signatures.push(value);
  }
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || signatures.length === 0) {
    throw new Error("Malformed Stripe signature");
  }
  if (Math.abs(nowMs - Number(timestamp) * 1000) > toleranceSeconds * 1000) {
    throw new Error("Stripe signature timestamp is outside tolerance");
  }
  const expected = createHmac("sha256", webhookSecret).update(`${timestamp}.${rawBody}`).digest();
  const ok = signatures.some((candidate) => {
    if (!/^[a-f0-9]{64}$/.test(candidate)) return false;
    const supplied = Buffer.from(candidate, "hex");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
  if (!ok) throw new Error("Invalid Stripe signature");
}

export function signStripePayload(rawBody: string, timestamp: number, webhookSecret: string) {
  const v1 = createHmac("sha256", webhookSecret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

export interface MappedStripeEvent {
  eventId: string;
  gateway: typeof STRIPE_GATEWAY_NAME;
  provider: typeof STRIPE_GATEWAY_NAME;
  providerReference: string;
  executionId: string;
  type: PaymentExecutionType;
  amountCents: number;
  currency: string;
  status: "PROCESSING" | "SUCCEEDED" | "FAILED" | "CANCELED";
  occurredAt: string;
  failureCode?: string;
  failureMessage?: string;
}

/**
 * Map a verified Stripe event to the provider-neutral webhook shape. Returns
 * null for event types RAM does not act on (acknowledged, not processed).
 */
export function mapStripeEvent(event: unknown): MappedStripeEvent | null {
  if (!event || typeof event !== "object") throw new Error("Invalid Stripe event");
  const e = event as { id?: unknown; type?: unknown; created?: unknown; data?: { object?: Record<string, unknown> } };
  if (typeof e.id !== "string" || !e.id.startsWith("evt_") || typeof e.type !== "string" ||
      typeof e.created !== "number" || !e.data?.object) {
    throw new Error("Invalid Stripe event");
  }
  const object = e.data.object;
  const meta = object.metadata as Record<string, unknown> | undefined;
  const executionId = meta?.ram_execution_id;
  if (typeof executionId !== "string" || typeof object.id !== "string") return null;
  let status: MappedStripeEvent["status"] | null = null;
  let failureCode: string | undefined;
  let failureMessage: string | undefined;
  switch (e.type) {
    case "payment_intent.processing": status = "PROCESSING"; break;
    case "payment_intent.succeeded": status = "SUCCEEDED"; break;
    case "payment_intent.canceled": status = "CANCELED"; break;
    case "payment_intent.payment_failed": {
      status = "FAILED";
      const err = object.last_payment_error as Record<string, unknown> | undefined;
      failureCode = typeof err?.code === "string" ? err.code : "payment_failed";
      failureMessage = typeof err?.message === "string" ? err.message.slice(0, 500) : undefined;
      break;
    }
    case "transfer.created": status = "SUCCEEDED"; break;
    case "transfer.reversed": status = null; break; // reversal is a finance incident, not an execution status
    case "refund.created":
    case "refund.updated": {
      const s = object.status;
      status = s === "succeeded" ? "SUCCEEDED" : s === "failed" ? "FAILED" : s === "canceled" ? "CANCELED" : "PROCESSING";
      if (status === "FAILED") failureCode = typeof object.failure_reason === "string" ? object.failure_reason : "refund_failed";
      break;
    }
    default: status = null;
  }
  if (!status) return null;
  const type: PaymentExecutionType | null = object.id.startsWith("pi_") ? "BUYER_COLLECTION"
    : object.id.startsWith("tr_") ? "SUPPLIER_PAYOUT" : object.id.startsWith("re_") ? "BUYER_REFUND" : null;
  if (!type || typeof object.amount !== "number" || typeof object.currency !== "string") return null;
  return {
    eventId: e.id,
    gateway: STRIPE_GATEWAY_NAME,
    provider: STRIPE_GATEWAY_NAME,
    providerReference: object.id,
    executionId,
    type,
    amountCents: object.amount,
    currency: object.currency.toUpperCase(),
    status,
    occurredAt: new Date(e.created * 1000).toISOString(),
    ...(failureCode ? { failureCode } : {}),
    ...(failureMessage ? { failureMessage } : {})
  };
}
