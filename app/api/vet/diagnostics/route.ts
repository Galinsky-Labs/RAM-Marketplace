import { NextRequest, NextResponse } from "next/server";
import { requireRequestSession } from "@/lib/auth/session";
import { acknowledgeDiagnosticReport, listDiagnosticReports } from "@/lib/server/diagnostics";

function status(message: string) {
  return /Authentication/.test(message) ? 401 : /Forbidden/.test(message) ? 403 : /not found|already/.test(message) ? 409 : 400;
}

export async function GET(request: NextRequest) {
  try {
    const session = await requireRequestSession(request);
    const animalCaseId = new URL(request.url).searchParams.get("animalCaseId") ?? "";
    if (!/^[A-Za-z0-9._:-]{3,120}$/.test(animalCaseId)) throw new Error("Invalid animal case id");
    return NextResponse.json({ reports: await listDiagnosticReports(session, animalCaseId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to list diagnostic reports";
    return NextResponse.json({ error: message }, { status: status(message) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireRequestSession(request);
    const form = await request.formData();
    const id = String(form.get("id") ?? "");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("Invalid diagnostic report id");
    const report = await acknowledgeDiagnosticReport(session, id, String(form.get("note") ?? ""));
    return NextResponse.redirect(new URL("/vet/" + encodeURIComponent(report.animalCaseId), request.url), 303);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to acknowledge diagnostic report";
    return NextResponse.json({ error: message }, { status: status(message) });
  }
}
