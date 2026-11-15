import { paymentGatewayConfig, type PaymentGatewayConfig } from "./gateway";
import { stripeConfig, type StripeConfig } from "./stripe";

/**
 * The single active payment rail. Exactly one of the provider-neutral signed
 * HTTP gateway or the Stripe adapter may be configured; with neither, payments
 * are disabled (the public demo runs this way: no real money movement).
 */
export type PaymentRail =
  | { kind: "http"; name: string; http: PaymentGatewayConfig }
  | { kind: "stripe"; name: string; stripe: StripeConfig };

export function activePaymentRail(env: Record<string, string | undefined> = process.env): PaymentRail | null {
  const http = paymentGatewayConfig(env);
  const stripe = stripeConfig(env);
  if (http && stripe) {
    throw new Error("Configure either the RAM payment gateway or Stripe, not both");
  }
  if (stripe) return { kind: "stripe", name: stripe.name, stripe };
  if (http) return { kind: "http", name: http.name, http };
  return null;
}
