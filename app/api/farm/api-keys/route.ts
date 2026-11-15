import { NextRequest, NextResponse } from "next/server";
import { requireRequestSession } from "@/lib/auth/session";
import { createOrganizationApiKey, listOrganizationApiKeys, revokeOrganizationApiKey } from "@/lib/server/api-keys";

function status(message: string) {
  return /Authentication/.test(message) ? 401 : /Forbidden/.test(message) ? 403 : /not found/.test(message) ? 404 : 400;
}

async function body(request: NextRequest): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 4096) throw new Error("Request body too large");
  const value = JSON.parse(text || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
  return value;
}

export async function GET(request: NextRequest) {
  try {
    const session = await requireRequestSession(request);
    return NextResponse.json({ keys: await listOrganizationApiKeys(session) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to list API keys";
    return NextResponse.json({ error: message }, { status: status(message) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireRequestSession(request);
    const input = await body(request);
    const key = await createOrganizationApiKey(session, input);
    return NextResponse.json({ key, notice: "Store this token now; it is not shown again." }, {
      status: 201, headers: { "Cache-Control": "no-store" }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create API key";
    return NextResponse.json({ error: message }, { status: status(message) });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await requireRequestSession(request);
    const id = new URL(request.url).searchParams.get("id") ?? "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("Invalid API key id");
    return NextResponse.json({ key: await revokeOrganizationApiKey(session, id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to revoke API key";
    return NextResponse.json({ error: message }, { status: status(message) });
  }
}
