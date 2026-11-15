// Mock of the Stripe REST API for CI only. Request validation and response
// objects follow Stripe's documented shapes (form-encoded bodies with bracket
// notation, Bearer secret key, Idempotency-Key replay, error envelopes).
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const port = Number(process.env.RAM_FAKE_STRIPE_PORT ?? 4122);
const requests = [];
const idempotency = new Map();
const objects = new Map();
const id = (prefix) => prefix + "_" + randomBytes(12).toString("base64url").replace(/[^A-Za-z0-9]/g, "x");
const now = () => Math.floor(Date.now() / 1000);

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", "request-id": id("req"), ...headers });
  res.end(JSON.stringify(body));
}
function stripeError(res, status, type, message, extra = {}) {
  send(res, status, { error: { type, message, ...extra } });
}
function metadataOf(form) {
  const metadata = {};
  for (const [key, value] of form) {
    const m = /^metadata\[([^\]]+)\]$/.exec(key);
    if (m) metadata[m[1]] = value;
  }
  return metadata;
}
function requireFields(res, form, fields) {
  for (const field of fields) {
    if (!form.get(field)) { stripeError(res, 400, "invalid_request_error", `Missing required param: ${field}.`, { code: "parameter_missing", param: field }); return false; }
  }
  return true;
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/__requests") return send(res, 200, { requests });
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const auth = req.headers.authorization ?? "";
  if (!/^Bearer (sk|rk)_test_[A-Za-z0-9]+$/.test(auth)) {
    return stripeError(res, 401, "invalid_request_error", "Invalid API Key provided.");
  }
  if (req.method !== "POST") return stripeError(res, 404, "invalid_request_error", "Unrecognized request URL.");
  if (!/application\/x-www-form-urlencoded/.test(req.headers["content-type"] ?? "")) {
    return stripeError(res, 400, "invalid_request_error", "Invalid request: unsupported Content-Type.");
  }
  const form = new URLSearchParams(raw);
  const key = req.headers["idempotency-key"];
  requests.push({ path: url.pathname, idempotencyKey: key ?? null, stripeVersion: req.headers["stripe-version"] ?? null, params: Object.fromEntries(form) });
  if (key && idempotency.has(key)) {
    const prior = idempotency.get(key);
    if (prior.raw !== raw || prior.path !== url.pathname) {
      return stripeError(res, 400, "idempotency_error", "Keys for idempotent requests can only be used with the same parameters they were first used with.");
    }
    return send(res, prior.status, prior.body, { "idempotent-replayed": "true" });
  }
  const remember = (status, body) => { if (key) idempotency.set(key, { raw, path: url.pathname, status, body }); send(res, status, body); };
  const amount = Number(form.get("amount"));
  const metadata = metadataOf(form);

  if (url.pathname === "/v1/payment_intents") {
    if (!requireFields(res, form, ["amount", "currency", "customer", "payment_method"])) return;
    const pi = {
      id: id("pi"), object: "payment_intent", amount, amount_received: 0, currency: form.get("currency"),
      customer: form.get("customer"), payment_method: form.get("payment_method"), confirmation_method: "automatic",
      capture_method: "automatic", created: now(), description: form.get("description"), livemode: false, metadata,
      latest_charge: null, last_payment_error: null, status: "processing"
    };
    if (form.get("payment_method") === "pm_card_chargeDeclined") {
      pi.status = "requires_payment_method";
      pi.last_payment_error = { type: "card_error", code: "card_declined", decline_code: "generic_decline", message: "Your card was declined." };
      objects.set(pi.id, pi);
      return remember(402, { error: { type: "card_error", code: "card_declined", decline_code: "generic_decline", message: "Your card was declined.", payment_intent: pi } });
    }
    objects.set(pi.id, pi);
    return remember(200, pi);
  }
  if (url.pathname === "/v1/transfers") {
    if (!requireFields(res, form, ["amount", "currency", "destination"])) return;
    const tr = {
      id: id("tr"), object: "transfer", amount, amount_reversed: 0, currency: form.get("currency"), created: now(),
      destination: form.get("destination"), destination_payment: id("py"), livemode: false, metadata, reversals: { object: "list", data: [], has_more: false },
      reversed: false, transfer_group: form.get("transfer_group")
    };
    objects.set(tr.id, tr);
    return remember(200, tr);
  }
  if (url.pathname === "/v1/refunds") {
    if (!requireFields(res, form, ["payment_intent"])) return;
    if (!objects.has(form.get("payment_intent")) && !String(form.get("payment_intent")).startsWith("pi_")) {
      return stripeError(res, 400, "invalid_request_error", "No such payment_intent", { code: "resource_missing" });
    }
    const re = { id: id("re"), object: "refund", amount, currency: "usd", created: now(), payment_intent: form.get("payment_intent"), metadata, reason: null, status: "pending" };
    objects.set(re.id, re);
    return remember(200, re);
  }
  stripeError(res, 404, "invalid_request_error", "Unrecognized request URL (POST: " + url.pathname + ").");
}).listen(port, "127.0.0.1", () => console.log("fake Stripe API on " + port));
