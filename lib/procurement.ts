/**
 * Institutional procurement: purchase orders for research buyer orders.
 * A buyer organization may require an approved PO before buyer commitment.
 * Requester and approver must differ; amounts above the single-approver limit
 * need a second, distinct approver. The PO amount must equal the quoted price.
 */
export type PurchaseOrderStatus = "REQUESTED" | "PARTIALLY_APPROVED" | "APPROVED" | "REJECTED" | "CANCELED";

export interface ProcurementPolicyRecord {
  requirePurchaseOrder: boolean;
  singleApproverLimitCents: number;
}

export interface PurchaseOrderRecord {
  status: PurchaseOrderStatus;
  amountCents: number;
  requestedById: string;
  firstApproverId: string | null;
  secondApproverId: string | null;
}

export function normalizePurchaseOrderRequest(input: { poNumber?: unknown; costCenter?: unknown }) {
  const poNumber = typeof input.poNumber === "string" ? input.poNumber.trim() : "";
  const costCenter = typeof input.costCenter === "string" ? input.costCenter.trim() : "";
  if (!/^[A-Za-z0-9._/-]{3,60}$/.test(poNumber)) throw new Error("PO number must be 3-60 letters, digits or ._/-");
  if (costCenter.length < 2 || costCenter.length > 80) throw new Error("Cost center must be 2-80 characters");
  return { poNumber, costCenter };
}

export function normalizeProcurementPolicy(input: { requirePurchaseOrder?: unknown; singleApproverLimitUsd?: unknown }): ProcurementPolicyRecord {
  if (typeof input.requirePurchaseOrder !== "boolean") throw new Error("requirePurchaseOrder must be boolean");
  const usd = Number(input.singleApproverLimitUsd);
  if (!Number.isFinite(usd) || usd < 0 || usd > 10_000_000) throw new Error("Single-approver limit must be 0 to 10,000,000 USD");
  return { requirePurchaseOrder: input.requirePurchaseOrder, singleApproverLimitCents: Math.round(usd * 100) };
}

/** Apply one approval and return the next status and approver fields. */
export function approvePurchaseOrder(
  po: PurchaseOrderRecord,
  approverId: string,
  policy: ProcurementPolicyRecord
): Pick<PurchaseOrderRecord, "status" | "firstApproverId" | "secondApproverId"> {
  if (po.status !== "REQUESTED" && po.status !== "PARTIALLY_APPROVED") throw new Error("Purchase order is not awaiting approval");
  if (approverId === po.requestedById) throw new Error("Forbidden: the requester cannot approve their own purchase order");
  const needsTwo = po.amountCents > policy.singleApproverLimitCents;
  if (po.status === "REQUESTED") {
    return needsTwo
      ? { status: "PARTIALLY_APPROVED", firstApproverId: approverId, secondApproverId: null }
      : { status: "APPROVED", firstApproverId: approverId, secondApproverId: null };
  }
  if (approverId === po.firstApproverId) throw new Error("Forbidden: a second, different approver is required");
  return { status: "APPROVED", firstApproverId: po.firstApproverId, secondApproverId: approverId };
}

/** Buyer commitment gate. */
export function assertProcurementSatisfied(
  policy: ProcurementPolicyRecord | null,
  po: { status: string; amountCents: number } | null,
  quotedCents: number | null
) {
  if (!policy?.requirePurchaseOrder) return;
  if (!po || po.status !== "APPROVED") throw new Error("An approved purchase order is required before buyer commitment");
  if (quotedCents === null || po.amountCents !== quotedCents) {
    throw new Error("Purchase order amount does not match the quoted price");
  }
}
