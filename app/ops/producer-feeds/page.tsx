import Link from "next/link";
import { can } from "@/lib/access";
import { requireSession } from "@/lib/auth/session";
import { dataBackend } from "@/lib/server/db";
import { listQuarantinedFeeds } from "@/lib/server/producer-feeds";

export const dynamic = "force-dynamic";

export default async function ProducerFeedsPage() {
  const session = await requireSession();
  if (!can(session.role, "operations:manage")) {
    return <section className="page"><h1>Restricted</h1><p>RAM operations role required.</p></section>;
  }
  const batches = dataBackend() === "postgres" ? await listQuarantinedFeeds(session) : [];
  return (
    <section className="page">
      <div className="pageHeader">
        <div><div className="eyebrow">RAM operations · producer data feeds</div><h1>Quarantined producer feeds</h1>
          <p>Batches submitted by supplier systems (CSV or JSON, via session or API key) wait here. Promotion creates SUBMITTED animal cases that still need veterinary pre-screen; nothing is listed, priced or moved.</p>
        </div>
        <Link href="/ops" className="secondaryButton">Back to operations</Link>
      </div>
      {batches.length === 0 ? <div className="panel"><p>No batches are waiting in quarantine.</p></div> : batches.map((batch) => (
        <div className="panel" key={batch.id}>
          <h2>{batch.batchKey}</h2>
          <p>{batch.organization.name} · {batch.rowCount} animal(s) · received {batch.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC</p>
          <form className="formStack" method="post" action="/api/ops/producer-feeds">
            <input type="hidden" name="id" value={batch.id} />
            <label>Verification note (required)<textarea name="note" required minLength={5} maxLength={2000} placeholder="e.g. Confirmed with farm contact by phone; IDs match herd records." /></label>
            <div className="formActions">
              <button className="primaryButton" name="action" value="PROMOTE" type="submit">Verify and promote</button>
              <button className="secondaryButton" name="action" value="REJECT" type="submit">Reject</button>
            </div>
          </form>
        </div>
      ))}
    </section>
  );
}
