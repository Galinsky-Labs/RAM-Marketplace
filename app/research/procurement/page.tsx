import Link from "next/link";
import { requireSession } from "@/lib/auth/session";
import { dataBackend } from "@/lib/server/db";
import { getProcurementOverview } from "@/lib/server/procurement";

export const dynamic = "force-dynamic";

const usd = (cents: number | null | undefined) => cents == null ? "—" : "$" + (cents / 100).toFixed(2);

export default async function ProcurementPage() {
  const session = await requireSession();
  if (session.role !== "RESEARCH_PI" && session.role !== "RESEARCH_PROCUREMENT") {
    return <section className="page"><h1>Restricted</h1><p>Research buyer role required.</p></section>;
  }
  const { policy, orders } = dataBackend() === "postgres" ? await getProcurementOverview(session) : { policy: null, orders: [] };
  const approver = session.role === "RESEARCH_PROCUREMENT";
  return (
    <section className="page">
      <div className="pageHeader">
        <div><div className="eyebrow">Institutional procurement</div><h1>Purchase orders</h1>
          <p>Attach your institution's purchase order to a quoted order. The requester cannot approve their own PO; amounts above the single-approver limit need two different procurement approvers. When your policy requires a PO, buyer commitment is blocked until it is approved for the exact quoted amount.</p>
        </div>
        <Link href="/research" className="secondaryButton">Back to research</Link>
      </div>
      <div className="panel">
        <h2>Policy</h2>
        <p>{policy?.requirePurchaseOrder ? `Approved PO required before commitment; single-approver limit ${usd(policy.singleApproverLimitCents)}.` : "No PO requirement configured."}</p>
        {approver && (
          <form method="post" action="/api/research/procurement" className="formActions">
            <input type="hidden" name="action" value="POLICY" />
            <label><input type="checkbox" name="requirePurchaseOrder" defaultChecked={policy?.requirePurchaseOrder ?? false} /> Require approved PO</label>
            <label>Single-approver limit (USD)<input name="singleApproverLimitUsd" type="number" min={0} step="0.01" defaultValue={(policy?.singleApproverLimitCents ?? 0) / 100} /></label>
            <button className="secondaryButton" type="submit">Save policy</button>
          </form>
        )}
      </div>
      <div className="panel">
        <h2>Orders</h2>
        {orders.length === 0 ? <p>No quoted orders awaiting commitment.</p> : orders.map((order) => (
          <div key={order.id} className="formStack">
            <p><strong>{order.animalCaseId}</strong> · {order.status.replaceAll("_", " ")} · quote {usd(order.buyerPriceCents)}
              {order.purchaseOrder ? ` · PO ${order.purchaseOrder.poNumber} (${order.purchaseOrder.costCenter}) ${order.purchaseOrder.status}` : " · no PO"}</p>
            {order.status === "CHECKOUT_PENDING" && (!order.purchaseOrder || ["REJECTED", "CANCELED"].includes(order.purchaseOrder.status)) && (
              <form method="post" action="/api/research/procurement" className="formActions">
                <input type="hidden" name="action" value="REQUEST" /><input type="hidden" name="orderId" value={order.id} />
                <label>PO number<input name="poNumber" required /></label>
                <label>Cost center<input name="costCenter" required /></label>
                <button className="secondaryButton" type="submit">Request PO approval</button>
              </form>
            )}
            {approver && order.purchaseOrder && ["REQUESTED", "PARTIALLY_APPROVED"].includes(order.purchaseOrder.status) && (
              <form method="post" action="/api/research/procurement" className="formActions">
                <input type="hidden" name="orderId" value={order.id} />
                <label>Note<input name="note" /></label>
                <button className="primaryButton" name="action" value="APPROVE" type="submit">Approve</button>
                <button className="secondaryButton" name="action" value="REJECT" type="submit">Reject</button>
              </form>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
