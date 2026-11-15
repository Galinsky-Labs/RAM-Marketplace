import Link from "next/link";
import { can } from "@/lib/access";
import { requireSession } from "@/lib/auth/session";
import { dataBackend } from "@/lib/server/db";
import { listPaymentReconciliationRuns } from "@/lib/server/payment-reconciliation";

export const dynamic = "force-dynamic";

const example = JSON.stringify({
  provider: "stripe",
  periodStart: "2026-11-01T00:00:00Z",
  periodEnd: "2026-12-01T00:00:00Z",
  lines: [{ providerReference: "pi_example", idempotencyKey: "optional-ram-key", amountCents: 125000, currency: "USD", status: "SUCCEEDED", occurredAt: "2026-11-03T15:00:00Z" }]
}, null, 2);

export default async function ReconciliationPage() {
  const session = await requireSession();
  if (!can(session.role, "settlement:manage")) {
    return <section className="page"><h1>Restricted</h1><p>RAM finance role required.</p></section>;
  }
  const runs = dataBackend() === "postgres" ? await listPaymentReconciliationRuns(session) : [];
  const dollars = (cents: number) => "$" + (cents / 100).toFixed(2);
  return (
    <section className="page">
      <div className="pageHeader">
        <div><div className="eyebrow">RAM finance</div><h1>Payment reconciliation</h1>
          <p>Compare a provider statement for a period with RAM payment executions. Any amount, currency or status mismatch, missing provider line or unknown provider line leaves the period unreconciled.</p>
        </div>
        <Link href="/finance" className="secondaryButton">Back to finance</Link>
      </div>
      <form className="panel formStack" method="post" action="/api/finance/reconciliation">
        <label>Provider statement (JSON)<textarea name="statement" rows={12} required defaultValue={example} /></label>
        <div className="formActions"><button className="primaryButton" type="submit">Run reconciliation</button></div>
      </form>
      <div className="panel">
        <h2>Recent runs</h2>
        {runs.length === 0 ? <p>No reconciliation runs yet.</p> : (
          <div className="tableScroll"><table className="dataTable">
            <thead><tr><th>Provider</th><th>Period</th><th>Result</th><th>Matched</th><th>Discrepancies</th><th>RAM succeeded</th><th>Provider succeeded</th></tr></thead>
            <tbody>{runs.map((run) => (
              <tr key={run.id}>
                <td>{run.provider}</td>
                <td>{run.periodStart.toISOString().slice(0, 10)} – {run.periodEnd.toISOString().slice(0, 10)}</td>
                <td>{run.reconciled ? "RECONCILED" : "DISCREPANCY"}</td>
                <td>{run.matched}/{run.executionCount}</td>
                <td>{run.discrepancyCount}</td>
                <td>{dollars(run.ramSucceededCents)}</td>
                <td>{dollars(run.providerSucceededCents)}</td>
              </tr>))}
            </tbody>
          </table></div>
        )}
      </div>
    </section>
  );
}
