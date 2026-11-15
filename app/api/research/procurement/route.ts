import { NextRequest, NextResponse } from "next/server";
import { requireRequestSession } from "@/lib/auth/session";
import { errorStatus, readActionBody } from "@/lib/server/request-body";
import { decidePurchaseOrder, getProcurementOverview, requestPurchaseOrder, setProcurementPolicy } from "@/lib/server/procurement";

export async function GET(request: NextRequest) {
  try {
    const session = await requireRequestSession(request);
    return NextResponse.json(await getProcurementOverview(session));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load procurement";
    return NextResponse.json({ error: message }, { status: errorStatus(message) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireRequestSession(request);
    const { body, form } = await readActionBody(request);
    const orderId = String(body.orderId ?? "");
    let result;
    switch (body.action) {
      case "POLICY":
        result = await setProcurementPolicy(session, {
          requirePurchaseOrder: body.requirePurchaseOrder === true || body.requirePurchaseOrder === "true" || body.requirePurchaseOrder === "on",
          singleApproverLimitUsd: body.singleApproverLimitUsd
        });
        break;
      case "REQUEST": result = await requestPurchaseOrder(session, orderId, body); break;
      case "APPROVE": result = await decidePurchaseOrder(session, orderId, "APPROVE", String(body.note ?? "")); break;
      case "REJECT": result = await decidePurchaseOrder(session, orderId, "REJECT", String(body.note ?? "")); break;
      default: throw new Error("Unknown procurement action");
    }
    if (form) return NextResponse.redirect(new URL("/research/procurement", request.url), 303);
    return NextResponse.json({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update procurement";
    return NextResponse.json({ error: message }, { status: errorStatus(message) });
  }
}
