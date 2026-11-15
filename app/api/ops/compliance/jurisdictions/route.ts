import { NextRequest, NextResponse } from "next/server";
import { requireRequestSession } from "@/lib/auth/session";
import { errorStatus, readActionBody } from "@/lib/server/request-body";
import { approveJurisdiction, listJurisdictionsForReview, proposeJurisdiction, suspendJurisdiction } from "@/lib/server/jurisdictions";

export async function GET(request: NextRequest) {
  try {
    const session = await requireRequestSession(request);
    return NextResponse.json({ jurisdictions: await listJurisdictionsForReview(session) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to list jurisdictions";
    return NextResponse.json({ error: message }, { status: errorStatus(message) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireRequestSession(request);
    const { body, form } = await readActionBody(request);
    const id = String(body.id ?? "");
    let jurisdiction;
    switch (body.action) {
      case "PROPOSE": jurisdiction = await proposeJurisdiction(session, body); break;
      case "APPROVE": jurisdiction = await approveJurisdiction(session, id); break;
      case "SUSPEND": jurisdiction = await suspendJurisdiction(session, id, String(body.reason ?? "")); break;
      default: throw new Error("Unknown jurisdiction action");
    }
    if (form) return NextResponse.redirect(new URL("/ops/compliance/jurisdictions", request.url), 303);
    return NextResponse.json({ jurisdiction });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update jurisdiction";
    return NextResponse.json({ error: message }, { status: errorStatus(message) });
  }
}
