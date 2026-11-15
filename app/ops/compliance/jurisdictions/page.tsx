import Link from "next/link";
import { requireSession } from "@/lib/auth/session";
import { dataBackend } from "@/lib/server/db";
import { listJurisdictionsForReview } from "@/lib/server/jurisdictions";
import { SPECIES_CATALOG } from "@/lib/species";

export const dynamic = "force-dynamic";

export default async function JurisdictionsPage() {
  const session = await requireSession();
  if (session.role !== "RAM_COMPLIANCE" && session.role !== "RAM_SUPER_ADMIN") {
    return <section className="page"><h1>Restricted</h1><p>RAM compliance reviewer role required.</p></section>;
  }
  const rows = dataBackend() === "postgres" ? await listJurisdictionsForReview(session) : [];
  return (
    <section className="page">
      <div className="pageHeader">
        <div><div className="eyebrow">RAM compliance · multi-state activation</div><h1>Jurisdiction activation</h1>
          <p>Open one state for one species at a time. A second reviewer (not the proposer) approves; any reviewer can suspend immediately. With corridor enforcement on, both corridor states must be ACTIVE in addition to a published rule.</p>
        </div>
        <Link href="/ops/compliance/rules" className="secondaryButton">Compliance rules</Link>
      </div>
      <div className="panel">
        <h2>Species catalog</h2>
        <div className="tableScroll"><table className="dataTable">
          <thead><tr><th>Species</th><th>Code</th><th>Status</th><th>Profile limits</th><th>Notes</th></tr></thead>
          <tbody>{SPECIES_CATALOG.map((s) => (
            <tr key={s.name}><td>{s.name}</td><td>{s.code}</td><td>{s.status}</td><td>≤{s.maxAgeMonths} mo, ≤{s.maxWeightKg} kg</td><td>{s.welfareNotes}</td></tr>
          ))}</tbody>
        </table></div>
      </div>
      <form className="panel formStack" method="post" action="/api/ops/compliance/jurisdictions">
        <h2>Propose a state activation</h2>
        <input type="hidden" name="action" value="PROPOSE" />
        <div className="formGrid">
          <label>State code<input name="stateCode" required maxLength={2} placeholder="IA" /></label>
          <label>Species<select name="species">{SPECIES_CATALOG.map((s) => <option key={s.name} value={s.name} disabled={s.status !== "PILOT"}>{s.name}{s.status !== "PILOT" ? " (groundwork)" : ""}</option>)}</select></label>
        </div>
        <label>Evidence reference (signed authority, memo or decision ID)<textarea name="evidenceReference" required minLength={8} maxLength={2000} /></label>
        <div className="formActions"><button className="primaryButton" type="submit">Propose</button></div>
      </form>
      <div className="panel">
        <h2>Activations</h2>
        {rows.length === 0 ? <p>No states are activated. Every corridor is closed when enforcement is on.</p> : (
          <div className="tableScroll"><table className="dataTable">
            <thead><tr><th>State</th><th>Species</th><th>Status</th><th>Evidence</th><th>Proposer / approver</th><th>Actions</th></tr></thead>
            <tbody>{rows.map((row) => (
              <tr key={row.id}>
                <td>{row.stateCode}</td><td>{row.species}</td><td>{row.status}</td><td>{row.evidenceReference}</td>
                <td>{row.proposedById} / {row.approvedById ?? "—"}</td>
                <td>
                  {row.status === "PROPOSED" && (
                    <form method="post" action="/api/ops/compliance/jurisdictions">
                      <input type="hidden" name="action" value="APPROVE" /><input type="hidden" name="id" value={row.id} />
                      <button className="secondaryButton" type="submit">Approve</button>
                    </form>
                  )}
                  {row.status !== "SUSPENDED" && (
                    <form method="post" action="/api/ops/compliance/jurisdictions">
                      <input type="hidden" name="action" value="SUSPEND" /><input type="hidden" name="id" value={row.id} />
                      <input name="reason" required minLength={5} placeholder="Suspension reason" />
                      <button className="secondaryButton" type="submit">Suspend</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </section>
  );
}
