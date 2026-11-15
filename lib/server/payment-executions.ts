import "server-only";

import { randomUUID } from "node:crypto";
import type { SessionPrincipal } from "@/lib/auth/token";
import { requireCapability } from "@/lib/access";
import {
  assertMovementWithinOutstanding,
  financialBalances,
  type FinancialMovementType
} from "@/lib/finance-policy";
import {
  assertExecutionStatusTransition,
  bodyHash,
  executionTypeToLedgerType,
  signGatewayMessage,
  verifyGatewaySignature,
  type PaymentExecutionStatus,
  type PaymentGatewayAcknowledgment
} from "@/lib/payments/gateway";
import {
  paymentExecutionRequestSchema,
  paymentWebhookSchema,
  type PaymentExecutionRequest,
  type PaymentWebhookInput
} from "@/lib/payments/validation";
import { requirePrisma } from "@/lib/server/db";
import { activePaymentRail } from "@/lib/payments/rail";
import { buildStripeRequest, stripeAcknowledgment, type StripeConfig } from "@/lib/payments/stripe";

function movementEntries(
  entries: Array<{ type: string; amountCents: number }>
) {
  return entries
    .filter(
      (entry): entry is { type: FinancialMovementType; amountCents: number } =>
        entry.type === "BUYER_PAYMENT" ||
        entry.type === "SUPPLIER_PAYOUT" ||
        entry.type === "BUYER_CREDIT" ||
        entry.type === "BUYER_REFUND"
    )
    .map((entry) => ({ type: entry.type, amountCents: entry.amountCents }));
}

function executionStatus(value: string): PaymentExecutionStatus {
  if (
    value === "CREATED" ||
    value === "SUBMITTED" ||
    value === "SUBMISSION_UNKNOWN" ||
    value === "PROCESSING" ||
    value === "SUCCEEDED" ||
    value === "FAILED" ||
    value === "CANCELED"
  ) {
    return value;
  }
  throw new Error("Unknown payment execution status");
}

function acknowledgment(value: unknown): PaymentGatewayAcknowledgment {
  if (!value || typeof value !== "object") {
    throw new Error("Payment gateway returned an invalid acknowledgment");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.gateway !== "string" ||
    typeof record.provider !== "string" ||
    typeof record.providerReference !== "string" ||
    (record.status !== "SUBMITTED" && record.status !== "PROCESSING")
  ) {
    throw new Error("Payment gateway returned an invalid acknowledgment");
  }
  return {
    gateway: record.gateway,
    provider: record.provider,
    providerReference: record.providerReference,
    status: record.status
  };
}

async function submitExecution(executionId: string) {
  const rail = activePaymentRail();
  if (rail?.kind === "stripe") return submitStripeExecution(executionId, rail.stripe);
  const config = rail?.kind === "http" ? rail.http : null;
  if (!config) {
    throw new Error("Payment gateway is not configured");
  }

  const prisma = requirePrisma();
  const execution = await prisma.paymentExecution.findUnique({
    where: { id: executionId }
  });
  if (!execution) throw new Error("Payment execution not found");

  if (
    execution.status !== "CREATED" &&
    execution.status !== "SUBMISSION_UNKNOWN"
  ) {
    throw new Error("Payment execution is not eligible for submission");
  }

  const rawBody = JSON.stringify({
    executionId: execution.id,
    settlementId: execution.settlementId,
    counterpartyOrganizationId: execution.counterpartyOrganizationId,
    accountReference: execution.accountReference,
    idempotencyKey: execution.idempotencyKey,
    type: execution.type,
    amountCents: execution.amountCents,
    currency: execution.currency
  });
  const requestPayloadHash = bodyHash(rawBody);
  await prisma.paymentExecution.update({
    where: { id: execution.id },
    data: { requestPayloadHash }
  });

  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signGatewayMessage(
    rawBody,
    timestamp,
    config.secret
  );

  let response: Response;
  try {
    response = await fetch(config.url + "/v1/executions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ram-gateway-timestamp": timestamp,
        "x-ram-gateway-signature": signature,
        "idempotency-key": execution.idempotencyKey
      },
      body: rawBody,
      signal: AbortSignal.timeout(15_000)
    });
  } catch (error) {
    if (execution.status !== "SUBMISSION_UNKNOWN") {
      assertExecutionStatusTransition(
        executionStatus(execution.status),
        "SUBMISSION_UNKNOWN"
      );
    }
    await prisma.paymentExecution.update({
      where: { id: execution.id },
      data: {
        status: "SUBMISSION_UNKNOWN",
        failureCode: "NETWORK_UNKNOWN",
        failureMessage:
          error instanceof Error ? error.message.slice(0, 2000) : "Unknown network failure"
      }
    });
    throw new Error(
      "Payment submission outcome is unknown; retry this execution with the same idempotency key"
    );
  }

  const responseBody = await response.text();

  if (!response.ok) {
    if (response.status >= 500) {
      await prisma.paymentExecution.update({
        where: { id: execution.id },
        data: {
          status: "SUBMISSION_UNKNOWN",
          failureCode: "GATEWAY_5XX",
          failureMessage: ("Gateway HTTP " + response.status).slice(0, 2000)
        }
      });
      throw new Error(
        "Payment gateway returned an ambiguous server error; retry the same execution"
      );
    }

    assertExecutionStatusTransition(
      executionStatus(execution.status),
      "FAILED"
    );
    await prisma.paymentExecution.update({
      where: { id: execution.id },
      data: {
        status: "FAILED",
        failureCode: "GATEWAY_REJECTED",
        failureMessage: ("Gateway HTTP " + response.status + ": " + responseBody).slice(
          0,
          2000
        ),
        completedAt: new Date()
      }
    });
    throw new Error("Payment gateway rejected the execution request");
  }

  let parsed: PaymentGatewayAcknowledgment;
  try {
    verifyGatewaySignature(
      responseBody,
      response.headers.get("x-ram-gateway-timestamp"),
      response.headers.get("x-ram-gateway-signature"),
      config.secret
    );

    parsed = acknowledgment(JSON.parse(responseBody));
    if (parsed.gateway !== config.name) {
      throw new Error("Payment gateway acknowledgment name mismatch");
    }
  } catch (error) {
    await prisma.paymentExecution.updateMany({
      where: {
        id: execution.id,
        status: { in: ["CREATED", "SUBMISSION_UNKNOWN"] }
      },
      data: {
        status: "SUBMISSION_UNKNOWN",
        failureCode: "ACKNOWLEDGMENT_INVALID",
        failureMessage:
          error instanceof Error
            ? error.message.slice(0, 2000)
            : "Invalid gateway acknowledgment"
      }
    });
    throw new Error(
      "Payment gateway acknowledgment could not be trusted; reconcile or retry the same execution"
    );
  }

  return applyAcknowledgment(execution.id, parsed);
}

async function applyAcknowledgment(executionId: string, parsed: PaymentGatewayAcknowledgment) {
  const prisma = requirePrisma();
  const current = await prisma.paymentExecution.findUnique({
    where: { id: executionId }
  });
  if (!current) throw new Error("Payment execution not found");

  if (
    current.providerReference &&
    current.providerReference !== parsed.providerReference
  ) {
    throw new Error("Payment gateway acknowledgment provider reference mismatch");
  }

  if (
    current.status === "SUCCEEDED" ||
    current.status === "FAILED" ||
    current.status === "CANCELED" ||
    current.status === "PROCESSING"
  ) {
    return current;
  }

  if (current.status === parsed.status) {
    return current;
  }

  assertExecutionStatusTransition(
    executionStatus(current.status),
    parsed.status
  );

  return prisma.paymentExecution.update({
    where: { id: executionId },
    data: {
      status: parsed.status,
      gateway: parsed.gateway,
      provider: parsed.provider,
      providerReference: parsed.providerReference,
      submittedAt: current.submittedAt ?? new Date(),
      failureCode: null,
      failureMessage: null
    }
  });
}


/** Submit one execution directly to Stripe (same idempotency and unknown-outcome rules). */
async function submitStripeExecution(executionId: string, config: StripeConfig) {
  const prisma = requirePrisma();
  const execution = await prisma.paymentExecution.findUnique({ where: { id: executionId } });
  if (!execution) throw new Error("Payment execution not found");
  if (execution.status !== "CREATED" && execution.status !== "SUBMISSION_UNKNOWN") {
    throw new Error("Payment execution is not eligible for submission");
  }
  const instruction = {
    executionId: execution.id,
    settlementId: execution.settlementId,
    counterpartyOrganizationId: execution.counterpartyOrganizationId,
    accountReference: execution.accountReference,
    idempotencyKey: execution.idempotencyKey,
    type: execution.type,
    amountCents: execution.amountCents,
    currency: execution.currency
  };
  const request = buildStripeRequest(instruction);
  await prisma.paymentExecution.update({
    where: { id: execution.id },
    data: { requestPayloadHash: bodyHash(request.path + "?" + request.params.toString()) }
  });

  let response: Response;
  try {
    response = await fetch(config.apiBase + request.path, {
      method: "POST",
      headers: {
        authorization: "Bearer " + config.secretKey,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": execution.idempotencyKey,
        "stripe-version": "2024-06-20"
      },
      body: request.params.toString(),
      signal: AbortSignal.timeout(20_000)
    });
  } catch (error) {
    await prisma.paymentExecution.update({
      where: { id: execution.id },
      data: {
        status: "SUBMISSION_UNKNOWN",
        failureCode: "NETWORK_UNKNOWN",
        failureMessage: error instanceof Error ? error.message.slice(0, 2000) : "Unknown network failure"
      }
    });
    throw new Error("Payment submission outcome is unknown; retry this execution with the same idempotency key");
  }

  const text = await response.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { body = null; }

  if (response.status >= 500 || response.status === 429 || response.status === 409) {
    // 409 = Stripe idempotency conflict in flight; all of these are ambiguous.
    await prisma.paymentExecution.update({
      where: { id: execution.id },
      data: { status: "SUBMISSION_UNKNOWN", failureCode: "STRIPE_" + response.status, failureMessage: "Stripe HTTP " + response.status }
    });
    throw new Error("Stripe returned an ambiguous response; retry the same execution");
  }
  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
    assertExecutionStatusTransition(executionStatus(execution.status), "FAILED");
    await prisma.paymentExecution.update({
      where: { id: execution.id },
      data: {
        status: "FAILED",
        failureCode: (error?.code ?? "STRIPE_" + response.status).slice(0, 240),
        failureMessage: (error?.message ?? "Stripe rejected the request").slice(0, 2000),
        completedAt: new Date()
      }
    });
    throw new Error("Stripe rejected the execution request");
  }
  let parsed: PaymentGatewayAcknowledgment;
  try {
    parsed = stripeAcknowledgment(execution.type, body, execution.id);
  } catch (error) {
    await prisma.paymentExecution.updateMany({
      where: { id: execution.id, status: { in: ["CREATED", "SUBMISSION_UNKNOWN"] } },
      data: {
        status: "SUBMISSION_UNKNOWN",
        failureCode: "ACKNOWLEDGMENT_INVALID",
        failureMessage: error instanceof Error ? error.message.slice(0, 2000) : "Invalid Stripe response"
      }
    });
    throw new Error("Stripe response could not be trusted; reconcile or retry the same execution");
  }
  return applyAcknowledgment(execution.id, parsed);
}

export async function initiatePaymentExecution(
  principal: SessionPrincipal,
  input: PaymentExecutionRequest
) {
  requireCapability(principal.role, "settlement:manage");
  const parsed = paymentExecutionRequestSchema.parse(input);
  const config = activePaymentRail();
  if (!config) {
    throw new Error("Payment gateway is not configured");
  }

  const prisma = requirePrisma();
  const amountCents = Math.round(parsed.amountUsd * 100);
  const ledgerType = executionTypeToLedgerType(parsed.type);

  const execution = await prisma.$transaction(async (tx) => {
    const settlement = await tx.financialSettlement.findUnique({
      where: { id: parsed.settlementId },
      include: {
        entries: { select: { type: true, amountCents: true } },
        order: {
          select: {
            buyerOrganizationId: true,
            animalCase: {
              select: {
                sourceRecord: {
                  select: {
                    farmSite: {
                      select: { organizationId: true }
                    }
                  }
                }
              }
            }
          }
        },
        paymentExecutions: {
          where: {
            type: parsed.type,
            status: {
              in: [
                "CREATED",
                "SUBMITTED",
                "SUBMISSION_UNKNOWN",
                "PROCESSING"
              ]
            }
          },
          select: { id: true, status: true }
        }
      }
    });

    if (!settlement) throw new Error("Financial settlement not found");
    if (settlement.status !== "OPEN") {
      throw new Error("Payment executions require an open financial settlement");
    }
    if (settlement.paymentExecutions.length > 0) {
      throw new Error(
        "An unresolved payment execution of this type already exists for the settlement"
      );
    }

    const counterpartyOrganizationId =
      parsed.type === "SUPPLIER_PAYOUT"
        ? settlement.order.animalCase.sourceRecord?.farmSite.organizationId
        : settlement.order.buyerOrganizationId;

    if (!counterpartyOrganizationId) {
      throw new Error(
        "Payment counterparty organization could not be resolved"
      );
    }

    const paymentProfile = await tx.organizationPaymentProfile.findUnique({
      where: { organizationId: counterpartyOrganizationId }
    });

    if (
      !paymentProfile ||
      paymentProfile.status !== "ACTIVE" ||
      paymentProfile.gateway !== config.name
    ) {
      throw new Error(
        "Counterparty does not have an active payment profile for the configured gateway"
      );
    }

    if (
      (parsed.type === "BUYER_COLLECTION" ||
        parsed.type === "BUYER_REFUND") &&
      !paymentProfile.buyerCollectionEnabled
    ) {
      throw new Error(
        "Counterparty payment profile is not enabled for buyer collections/refunds"
      );
    }

    if (
      parsed.type === "SUPPLIER_PAYOUT" &&
      !paymentProfile.supplierPayoutEnabled
    ) {
      throw new Error(
        "Counterparty payment profile is not enabled for supplier payouts"
      );
    }

    const balances = financialBalances(
      settlement,
      movementEntries(settlement.entries)
    );
    assertMovementWithinOutstanding(ledgerType, amountCents, balances);

    const created = await tx.paymentExecution.create({
      data: {
        settlementId: settlement.id,
        counterpartyOrganizationId,
        accountReference: paymentProfile.externalAccountReference,
        type: parsed.type,
        status: "CREATED",
        amountCents,
        currency: "USD",
        gateway: config.name,
        idempotencyKey: "ram-" + randomUUID(),
        requestedByUserId: principal.userId
      }
    });

    await tx.auditEvent.create({
      data: {
        actorUserId: principal.userId,
        organizationId: principal.organizationId,
        action: "PAYMENT_EXECUTION_CREATED",
        entityType: "PaymentExecution",
        entityId: created.id,
        nextState: {
          settlementId: settlement.id,
          counterpartyOrganizationId,
          type: created.type,
          amountCents,
          currency: created.currency,
          gateway: config.name
        }
      }
    });

    return created;
  });

  return submitExecution(execution.id);
}

export async function retryPaymentExecution(
  principal: SessionPrincipal,
  executionId: string
) {
  requireCapability(principal.role, "settlement:manage");

  const prisma = requirePrisma();
  const execution = await prisma.paymentExecution.findUnique({
    where: { id: executionId }
  });
  if (!execution) throw new Error("Payment execution not found");
  if (execution.status !== "SUBMISSION_UNKNOWN") {
    throw new Error("Only submission-unknown executions may be retried");
  }

  await prisma.auditEvent.create({
    data: {
      actorUserId: principal.userId,
      organizationId: principal.organizationId,
      action: "PAYMENT_EXECUTION_RETRY_REQUESTED",
      entityType: "PaymentExecution",
      entityId: execution.id,
      metadata: {
        idempotencyKey: execution.idempotencyKey
      }
    }
  });

  return submitExecution(execution.id);
}

export async function processPaymentWebhook(
  rawBody: string,
  timestamp: string | null,
  signature: string | null
) {
  const rail = activePaymentRail();
  const config = rail?.kind === "http" ? rail.http : null;
  if (!config) throw new Error("Payment gateway is not configured");

  verifyGatewaySignature(
    rawBody,
    timestamp,
    signature,
    config.secret
  );

  let input: PaymentWebhookInput;
  try {
    input = paymentWebhookSchema.parse(JSON.parse(rawBody));
  } catch {
    throw new Error("Invalid payment webhook payload");
  }

  return applyPaymentWebhook(input, config.name, bodyHash(rawBody));
}

/** Provider-neutral webhook application shared by the HTTP gateway and Stripe. */
export async function applyPaymentWebhook(input: PaymentWebhookInput, railName: string, payloadHash: string) {
  if (input.gateway !== railName) {
    throw new Error("Payment webhook gateway mismatch");
  }

  const prisma = requirePrisma();

  return prisma.$transaction(async (tx) => {
    const existing = await tx.paymentWebhookReceipt.findUnique({
      where: {
        gateway_eventId: {
          gateway: input.gateway,
          eventId: input.eventId
        }
      }
    });
    if (existing) {
      return { duplicate: true, result: existing.result };
    }

    const receipt = await tx.paymentWebhookReceipt.create({
      data: {
        gateway: input.gateway,
        eventId: input.eventId,
        executionId: input.executionId,
        payloadHash
      }
    });

    const execution = await tx.paymentExecution.findUnique({
      where: { id: input.executionId },
      include: {
        settlement: {
          include: {
            entries: { select: { type: true, amountCents: true } }
          }
        }
      }
    });
    if (!execution) {
      await tx.paymentWebhookReceipt.update({
        where: { id: receipt.id },
        data: {
          processedAt: new Date(),
          result: "EXECUTION_NOT_FOUND"
        }
      });
      throw new Error("Payment execution not found");
    }

    if (execution.gateway && execution.gateway !== input.gateway) {
      throw new Error("Payment execution gateway mismatch");
    }
    if (
      execution.providerReference &&
      execution.providerReference !== input.providerReference
    ) {
      throw new Error("Payment provider reference mismatch");
    }
    if (
      execution.type !== input.type ||
      execution.amountCents !== input.amountCents ||
      execution.currency !== input.currency
    ) {
      throw new Error(
        "Payment webhook does not match the requested execution amount, type or currency"
      );
    }

    if (execution.status === "SUCCEEDED") {
      await tx.paymentWebhookReceipt.update({
        where: { id: receipt.id },
        data: {
          processedAt: new Date(),
          result: "ALREADY_SUCCEEDED"
        }
      });
      return { duplicate: false, result: "ALREADY_SUCCEEDED" };
    }

    if (execution.status === input.status) {
      await tx.paymentWebhookReceipt.update({
        where: { id: receipt.id },
        data: {
          processedAt: new Date(),
          result: "NO_STATE_CHANGE"
        }
      });
      return { duplicate: false, result: "NO_STATE_CHANGE" };
    }

    assertExecutionStatusTransition(
      executionStatus(execution.status),
      input.status
    );

    if (input.status === "SUCCEEDED") {
      const ledgerType = executionTypeToLedgerType(execution.type);
      const balances = financialBalances(
        execution.settlement,
        movementEntries(execution.settlement.entries)
      );
      assertMovementWithinOutstanding(
        ledgerType,
        execution.amountCents,
        balances
      );

      const ledgerEntry = await tx.financialLedgerEntry.create({
        data: {
          settlementId: execution.settlementId,
          type: ledgerType,
          amountCents: execution.amountCents,
          externalReference:
            input.provider + ":" + input.providerReference,
          notes:
            "Recorded automatically from authenticated payment gateway webhook.",
          recordedByUserId: execution.requestedByUserId,
          occurredAt: new Date(input.occurredAt)
        }
      });

      await tx.paymentExecution.update({
        where: { id: execution.id },
        data: { ledgerEntryId: ledgerEntry.id }
      });
    }

    const terminal =
      input.status === "SUCCEEDED" ||
      input.status === "FAILED" ||
      input.status === "CANCELED";

    await tx.paymentExecution.update({
      where: { id: execution.id },
      data: {
        status: input.status,
        gateway: input.gateway,
        provider: input.provider,
        providerReference: input.providerReference,
        failureCode:
          input.status === "FAILED" ? input.failureCode ?? "PROVIDER_FAILED" : null,
        failureMessage:
          input.status === "FAILED" ? input.failureMessage ?? null : null,
        completedAt: terminal ? new Date(input.occurredAt) : null
      }
    });

    await tx.auditEvent.create({
      data: {
        actorUserId: execution.requestedByUserId,
        action: "PAYMENT_EXECUTION_" + input.status,
        entityType: "PaymentExecution",
        entityId: execution.id,
        nextState: {
          status: input.status,
          provider: input.provider,
          providerReference: input.providerReference
        },
        metadata: {
          eventId: input.eventId,
          failureCode: input.failureCode ?? null
        }
      }
    });

    await tx.paymentWebhookReceipt.update({
      where: { id: receipt.id },
      data: {
        processedAt: new Date(),
        result: input.status
      }
    });

    return { duplicate: false, result: input.status };
  });
}

export async function listPaymentExecutions(
  principal: SessionPrincipal,
  settlementId: string
) {
  requireCapability(principal.role, "settlement:manage");
  const prisma = requirePrisma();

  return prisma.paymentExecution.findMany({
    where: { settlementId },
    orderBy: { createdAt: "desc" }
  });
}
