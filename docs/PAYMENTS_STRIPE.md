# Stripe payment adapter

The provider-neutral payment rail (`lib/payments/rail.ts`) runs either the signed HTTP gateway (`RAM_PAYMENT_GATEWAY_*`) **or** Stripe (`RAM_STRIPE_*`) — never both. With neither configured, payment execution is disabled; the public demo runs that way and moves no money.

## Mapping
| RAM execution | Stripe call | Profile `externalAccountReference` |
| --- | --- | --- |
| BUYER_COLLECTION | `POST /v1/payment_intents` (confirm, off_session) | `cus_...:pm_...` |
| SUPPLIER_PAYOUT | `POST /v1/transfers` (Connect) | `acct_...` |
| BUYER_REFUND | `POST /v1/refunds` | original `pi_...` |

Every call uses the execution's RAM idempotency key as Stripe `Idempotency-Key` and carries `metadata[ram_execution_id]`. Network errors, 5xx, 409 and 429 leave the execution `SUBMISSION_UNKNOWN` (retry with the same key); 4xx marks it `FAILED`. Ledger money movement is appended only from a verified webhook.

Webhook: register `https://<host>/api/payments/stripe/webhook` for `payment_intent.*`, `transfer.created`, `refund.created`, `refund.updated`. Signatures (`Stripe-Signature`, 5-minute tolerance) are verified; events are mapped to the provider-neutral webhook and applied with the same idempotency, amount/type/currency matching and ledger rules as the HTTP gateway. Organization payment profiles must use gateway name `stripe`.

## Configuration
| Variable | Notes |
| --- | --- |
| `RAM_STRIPE_SECRET_KEY` | `sk_test_...`/`rk_test_...` for sandbox. Live (`sk_live_`) additionally needs `RAM_STRIPE_ALLOW_LIVE=true` — an owner decision. |
| `RAM_STRIPE_WEBHOOK_SECRET` | `whsec_...` from the Stripe webhook endpoint. |
| `RAM_STRIPE_ALLOW_LIVE` | `true` only after owner/finance approval (P0-08). |

Reconciliation: export the Stripe balance/payments report for a period into the statement JSON on `/finance/reconciliation` (provider `stripe`).
Pilot readiness: Stripe in test mode is reported as BLOCK for a real pilot (`payment_stripe`). Tests: `tests/stripe-adapter.test.ts` (no live Stripe calls were made; no keys were available).
