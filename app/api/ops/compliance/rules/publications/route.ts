import { NextRequest, NextResponse } from "next/server";
import { requireRequestSession } from "@/lib/auth/session";
import { readRuleDraftJson } from "@/lib/compliance-rule-drafts";
import { listPublishedRulesForReview, publishComplianceRule } from "@/lib/server/compliance-rules";

function status(message: string) {
  return /Authentication/.test(message) ? 401 : /Forbidden/.test(message) ? 403 : /already published|Stale/.test(message) ? 409 : 400;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requireRequestSession(request);
    return NextResponse.json({ rules: await listPublishedRulesForReview(principal) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to list published rules";
    return NextResponse.json({ error: message }, { status: status(message) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireRequestSession(request);
    const payload = await readRuleDraftJson(request) as { ruleId?: unknown; revision?: unknown; digest?: unknown };
    if (!payload || typeof payload !== "object") {
      return NextResponse.json({ error: "Invalid publication request" }, { status: 400 });
    }
    const rule = await publishComplianceRule(principal, {
      ruleId: String(payload.ruleId ?? ""),
      revision: Number(payload.revision),
      digest: String(payload.digest ?? "")
    });
    return NextResponse.json({ rule }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to publish rule";
    return NextResponse.json({ error: message }, { status: status(message) });
  }
}
