import { NextRequest, NextResponse } from "next/server";
import { requireRequestSession } from "@/lib/auth/session";
import { listQuarantinedFeeds, reviewProducerFeed } from "@/lib/server/producer-feeds";

function status(message: string) {
  return /Authentication/.test(message) ? 401 : /Forbidden/.test(message) ? 403 : /not found/.test(message) ? 404 : /no longer/.test(message) ? 409 : 400;
}

export async function GET(request: NextRequest) {
  try {
    const session = await requireRequestSession(request);
    return NextResponse.json({ batches: await listQuarantinedFeeds(session) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to list producer feeds";
    return NextResponse.json({ error: message }, { status: status(message) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireRequestSession(request);
    const contentType = request.headers.get("content-type") ?? "";
    let id: unknown, action: unknown, note: unknown;
    if (contentType.includes("application/json")) {
      const body = await request.json();
      ({ id, action, note } = body ?? {});
    } else {
      const form = await request.formData();
      id = form.get("id"); action = form.get("action"); note = form.get("note");
    }
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || (action !== "PROMOTE" && action !== "REJECT")) {
      return NextResponse.json({ error: "Invalid producer feed review" }, { status: 400 });
    }
    const result = await reviewProducerFeed(session, { id, action, note: typeof note === "string" ? note : "" });
    if (!contentType.includes("application/json")) {
      return NextResponse.redirect(new URL("/ops/producer-feeds", request.url), 303);
    }
    return NextResponse.json({ result, movementAuthorized: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to review producer feed";
    return NextResponse.json({ error: message }, { status: status(message) });
  }
}
