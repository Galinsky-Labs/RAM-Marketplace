import "server-only";
import type { SessionPrincipal } from "@/lib/auth/token";
import { requirePrisma } from "@/lib/server/db";
import {
  approvePurchaseOrder,
  normalizeProcurementPolicy,
  normalizePurchaseOrderRequest,
  type PurchaseOrderStatus
} from "@/lib/procurement";

const BUYER_ROLES = new Set(["RESEARCH_PI", "RESEARCH_PROCUREMENT"]);

function requireBuyer(principal: SessionPrincipal) {
  if (!BUYER_ROLES.has(principal.role)) throw new Error("Forbidden: research buyer role required");
}
function requireApprover(principal: SessionPrincipal) {
  if (principal.role !== "RESEARCH_PROCUREMENT") throw new Error("Forbidden: research procurement role required");
}

export async function getProcurementOverview(principal: SessionPrincipal) {
  requireBuyer(principal);
  const db = requirePrisma();
  const [policy, orders] = await Promise.all([
    db.buyerProcurementPolicy.findUnique({ where: { organizationId: principal.organizationId } }),
    db.order.findMany({
      where: { buyerOrganizationId: principal.organizationId, status: { in: ["CHECKOUT_PENDING", "BUYER_COMMITTED"] } },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, status: true, buyerPriceCents: true, animalCaseId: true, quoteExpiresAt: true, purchaseOrder: true }
    })
  ]);
  return { policy, orders };
}

export async function setProcurementPolicy(principal: SessionPrincipal, input: { requirePurchaseOrder?: unknown; singleApproverLimitUsd?: unknown }) {
  requireApprover(principal);
  const value = normalizeProcurementPolicy(input);
  const db = requirePrisma();
  const previous = await db.buyerProcurementPolicy.findUnique({ where: { organizationId: principal.organizationId } });
  const policy = await db.buyerProcurementPolicy.upsert({
    where: { organizationId: principal.organizationId },
    create: { organizationId: principal.organizationId, ...value, updatedById: principal.userId },
    update: { ...value, updatedById: principal.userId }
  });
  await db.auditEvent.create({
    data: {
      actorUserId: principal.userId, organizationId: principal.organizationId, action: "PROCUREMENT_POLICY_UPDATED",
      entityType: "BuyerProcurementPolicy", entityId: policy.id,
      previousState: previous ? { requirePurchaseOrder: previous.requirePurchaseOrder, singleApproverLimitCents: previous.singleApproverLimitCents } : undefined,
      nextState: { ...value }
    }
  });
  return policy;
}

export async function requestPurchaseOrder(principal: SessionPrincipal, orderId: string, input: { poNumber?: unknown; costCenter?: unknown }) {
  requireBuyer(principal);
  const value = normalizePurchaseOrderRequest(input);
  const db = requirePrisma();
  return db.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { id: orderId, buyerOrganizationId: principal.organizationId },
      include: { purchaseOrder: true }
    });
    if (!order) throw new Error("Order not found");
    if (order.status !== "CHECKOUT_PENDING") throw new Error("Purchase orders can only be requested for quoted orders awaiting commitment");
    if (order.buyerPriceCents === null) throw new Error("Order has no quoted price");
    const existing = order.purchaseOrder;
    if (existing && existing.status !== "REJECTED" && existing.status !== "CANCELED") {
      throw new Error("Conflict: an active purchase order already exists for this order");
    }
    const data = {
      buyerOrganizationId: principal.organizationId, ...value, amountCents: order.buyerPriceCents,
      status: "REQUESTED", requestedById: principal.userId, firstApproverId: null, secondApproverId: null, decidedAt: null, decisionNote: null
    };
    const po = existing
      ? await tx.purchaseOrder.update({ where: { id: existing.id }, data })
      : await tx.purchaseOrder.create({ data: { orderId: order.id, ...data } });
    await tx.auditEvent.create({
      data: {
        actorUserId: principal.userId, organizationId: principal.organizationId, action: "PURCHASE_ORDER_REQUESTED",
        entityType: "Order", entityId: order.id, nextState: { purchaseOrderId: po.id, status: "REQUESTED", amountCents: po.amountCents, poNumber: po.poNumber }
      }
    });
    return po;
  });
}

export async function decidePurchaseOrder(principal: SessionPrincipal, orderId: string, decision: "APPROVE" | "REJECT", note: string, now = new Date()) {
  requireApprover(principal);
  const db = requirePrisma();
  return db.$transaction(async (tx) => {
    const po = await tx.purchaseOrder.findFirst({ where: { orderId, buyerOrganizationId: principal.organizationId } });
    if (!po) throw new Error("Purchase order not found");
    const policy = await tx.buyerProcurementPolicy.findUnique({ where: { organizationId: principal.organizationId } });
    let next: { status: PurchaseOrderStatus; firstApproverId: string | null; secondApproverId: string | null };
    if (decision === "APPROVE") {
      next = approvePurchaseOrder(
        { status: po.status as PurchaseOrderStatus, amountCents: po.amountCents, requestedById: po.requestedById, firstApproverId: po.firstApproverId, secondApproverId: po.secondApproverId },
        principal.userId,
        policy ?? { requirePurchaseOrder: false, singleApproverLimitCents: Number.MAX_SAFE_INTEGER }
      );
    } else {
      if (po.status !== "REQUESTED" && po.status !== "PARTIALLY_APPROVED") throw new Error("Purchase order is not awaiting approval");
      if (!note || note.trim().length < 5) throw new Error("A rejection note of at least 5 characters is required");
      next = { status: "REJECTED", firstApproverId: po.firstApproverId, secondApproverId: po.secondApproverId };
    }
    const claimed = await tx.purchaseOrder.updateMany({
      where: { id: po.id, status: po.status },
      data: { ...next, decidedAt: next.status === "PARTIALLY_APPROVED" ? null : now, decisionNote: note?.trim() || null }
    });
    if (claimed.count !== 1) throw new Error("Conflict: purchase order changed concurrently");
    await tx.auditEvent.create({
      data: {
        actorUserId: principal.userId, organizationId: principal.organizationId, action: "PURCHASE_ORDER_" + next.status,
        entityType: "Order", entityId: orderId, previousState: { status: po.status }, nextState: { status: next.status }
      }
    });
    return tx.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
  });
}
