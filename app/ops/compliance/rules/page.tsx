import Link from "next/link";
import { requireSession } from "@/lib/auth/session";
import { RuleDraftEditor } from "./rule-draft-editor";
import { listCurrentPublishedRules } from "@/lib/server/compliance-rules";
import { dataBackend } from "@/lib/server/db";

export const dynamic = "force-dynamic";

export default async function ComplianceRuleDraftPage() {
  const session = await requireSession();
  if (session.role !== "RAM_COMPLIANCE" && session.role !== "RAM_SUPER_ADMIN") {
    return <section className="page"><h1>Restricted</h1><p>RAM compliance author role required.</p></section>;
  }
  const published = dataBackend() === "postgres" ? await listCurrentPublishedRules() : [];
  return (
    <section className="page">
      <div className="pageHeader">
        <div><div className="eyebrow">RAM compliance · review artifacts</div><h1>Versioned compliance rules</h1>
          <p>Prepare and revise source-backed corridor rules for later legal and veterinary review. No draft authorizes movement.</p>
        </div>
        <Link href="/ops" className="secondaryButton">Back to operations</Link>
      </div>
      <RuleDraftEditor authorId={session.userId} />
      <div className="panel">
        <h2>Published corridor rules (current revisions)</h2>
        <p>Corridor decisions are deny-by-default. A matching published prohibition always wins; otherwise a matching, in-effect published permit is required. Publishing requires a second compliance reviewer who is not the author.</p>
        {published.length === 0 ? <p>No rules are published. Every corridor is denied.</p> : (
          <div className="tableScroll"><table className="dataTable">
            <thead><tr><th>Rule</th><th>Rev</th><th>Corridor</th><th>Species / condition</th><th>Effect</th><th>Effective</th><th>Author / publisher</th></tr></thead>
            <tbody>
              {published.map((rule) => (
                <tr key={rule.digest}>
                  <td>{rule.ruleId}</td><td>{rule.revision}</td>
                  <td>{rule.originState} → {rule.destinationState}</td>
                  <td>{rule.species} / {rule.conditionFamily}</td>
                  <td>{rule.prohibited ? "PROHIBIT" : "PERMIT"}</td>
                  <td>{rule.effectiveFrom} – {rule.effectiveUntil}</td>
                  <td>{rule.authorId} / {rule.publishedById}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </section>
  );
}
