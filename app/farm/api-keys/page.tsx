import Link from "next/link";
import { requireSession } from "@/lib/auth/session";
import { ApiKeyManager } from "./api-key-manager";

export const dynamic = "force-dynamic";

export default async function FarmApiKeysPage() {
  const session = await requireSession();
  if (session.role !== "SUPPLIER_OWNER_ADMIN") {
    return <section className="page"><h1>Restricted</h1><p>Supplier organization administrator role required.</p></section>;
  }
  return (
    <section className="page">
      <div className="pageHeader">
        <div><div className="eyebrow">Supplier integration</div><h1>Enterprise API keys</h1>
          <p>Organization-scoped keys let your herd-management system submit supplier batches to quarantine with <code>Authorization: Bearer ramk_…</code>. Keys never publish, price or move animals and stop working immediately if your membership is suspended.</p>
        </div>
        <Link href="/farm" className="secondaryButton">Back to farm</Link>
      </div>
      <ApiKeyManager />
    </section>
  );
}
