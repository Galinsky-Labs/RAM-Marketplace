import { NextRequest, NextResponse } from "next/server";
import { requireRequestSession } from "@/lib/auth/session";
import { listPaymentReconciliationRuns, runPaymentReconciliation } from "@/lib/server/payment-reconciliation";

function status(message: string) {
  return /Authentication/.test(message) ? 401 : /Forbidden/.test(message) ? 403 : 400;
}

export async function GET(request: NextRequest) {
  try {
    const session = await requireRequestSession(request);
    return NextResponse.json({ runs: await listPaymentReconciliationRuns(session) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to list reconciliation runs";
    return NextResponse.json({ error: message }, { status: status(message) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireRequestSession(request);
    const contentType = request.headers.get("content-type") ?? "";
    let statement: unknown;
    if (contentType.includes("application/json")) {
      statement = await request.json();
    } else {
      const form = await request.formData();
      statement = JSON.parse(String(form.get("statement") ?? ""));
    }
    const { run, replay } = await runPaymentReconciliation(session, statement);
    if (!contentType.includes("application/json")) {
      return NextResponse.redirect(new URL("/finance/reconciliation", request.url), 303);
    }
    return NextResponse.json({ run, replay }, { status: replay ? 200 : 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to reconcile statement";
    return NextResponse.json({ error: message }, { status: status(message) });
  }
}
