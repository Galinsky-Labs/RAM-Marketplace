import { NextRequest, NextResponse } from "next/server";
import { activePaymentRail } from "@/lib/payments/rail";
import { mapStripeEvent, verifyStripeSignature } from "@/lib/payments/stripe";
import { bodyHash } from "@/lib/payments/gateway";
import { applyPaymentWebhook } from "@/lib/server/payment-executions";
import { paymentWebhookSchema } from "@/lib/payments/validation";

/** Stripe webhook endpoint. Register https://<host>/api/payments/stripe/webhook in Stripe. */
export async function POST(request: NextRequest) {
  let rail;
  try {
    rail = activePaymentRail();
  } catch {
    return NextResponse.json({ error: "Payment configuration is invalid" }, { status: 503 });
  }
  if (rail?.kind !== "stripe") {
    return NextResponse.json({ error: "Stripe is not configured" }, { status: 503 });
  }
  const raw = await request.text();
  if (raw.length > 524_288) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  try {
    verifyStripeSignature(raw, request.headers.get("stripe-signature"), rail.stripe.webhookSecret);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid signature" }, { status: 401 });
  }
  try {
    const mapped = mapStripeEvent(JSON.parse(raw));
    if (!mapped) return NextResponse.json({ ok: true, ignored: true });
    const result = await applyPaymentWebhook(paymentWebhookSchema.parse(mapped), rail.name, bodyHash(raw));
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to process Stripe event";
    const status = /Invalid Stripe event/.test(message) ? 400 : /not found/.test(message) ? 404 : 409;
    return NextResponse.json({ error: message }, { status });
  }
}
