import { NextRequest, NextResponse } from "next/server";
import { diagnosticsConfig, parseDiagnosticReport, verifyDiagnosticsSignature } from "@/lib/diagnostics";
import { ingestDiagnosticReport } from "@/lib/server/diagnostics";
import { dataBackend } from "@/lib/server/db";

/**
 * Signed diagnostic laboratory result intake.
 * Headers: x-ram-diagnostics-timestamp (unix seconds),
 *          x-ram-diagnostics-signature (hex HMAC-SHA256 of "<timestamp>.<raw body>").
 * Disabled (503) until RAM_DIAGNOSTICS_PROVIDER_NAME and RAM_DIAGNOSTICS_WEBHOOK_SECRET are set.
 */
export async function POST(request: NextRequest) {
  let config;
  try {
    config = diagnosticsConfig();
  } catch {
    return NextResponse.json({ error: "Diagnostics integration is misconfigured" }, { status: 503 });
  }
  if (!config || dataBackend() !== "postgres") {
    return NextResponse.json({ error: "Diagnostics integration is not enabled" }, { status: 503 });
  }
  const raw = await request.text();
  try {
    verifyDiagnosticsSignature(
      raw,
      request.headers.get("x-ram-diagnostics-timestamp"),
      request.headers.get("x-ram-diagnostics-signature"),
      config.secret
    );
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid signature" }, { status: 401 });
  }
  try {
    const { report, payloadHash } = parseDiagnosticReport(raw);
    const result = await ingestDiagnosticReport(config.provider, report, payloadHash);
    return NextResponse.json({ ok: true, ...result, statusChanged: false }, { status: result.replay ? 200 : 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to ingest diagnostic report";
    const status = /Conflict/.test(message) ? 409 : /Unknown animal/.test(message) ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
