// Minimal OpenID Connect provider for CI only (authorization code + PKCE, RS256 ID tokens).
import { createServer } from "node:http";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

const port = Number(process.env.RAM_FAKE_OIDC_PORT ?? 4121);
const issuer = `http://127.0.0.1:${port}`;
const clientId = process.env.RAM_OIDC_CLIENT_ID ?? "ci-client";
const clientSecret = process.env.RAM_OIDC_CLIENT_SECRET ?? "ci-secret";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "ci-key", use: "sig", alg: "RS256" };
const codes = new Map();

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function idToken(claims) {
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const data = enc({ alg: "RS256", kid: "ci-key", typ: "JWT" }) + "." + enc(claims);
  return data + "." + sign("sha256", Buffer.from(data), privateKey).toString("base64url");
}

createServer(async (req, res) => {
  const url = new URL(req.url, issuer);
  if (url.pathname === "/.well-known/openid-configuration") {
    return json(res, 200, { issuer, authorization_endpoint: issuer + "/authorize", token_endpoint: issuer + "/token", jwks_uri: issuer + "/jwks" });
  }
  if (url.pathname === "/jwks") return json(res, 200, { keys: [jwk] });
  if (url.pathname === "/authorize") {
    const p = url.searchParams;
    if (p.get("client_id") !== clientId || p.get("code_challenge_method") !== "S256") return json(res, 400, { error: "invalid_request" });
    const code = randomBytes(16).toString("hex");
    // login_hint selects the synthetic user; amr reflects MFA.
    codes.set(code, { nonce: p.get("nonce"), challenge: p.get("code_challenge"), redirect: p.get("redirect_uri"), email: p.get("login_hint") || "oidc.newcomer@example.org" });
    const target = new URL(p.get("redirect_uri"));
    target.searchParams.set("code", code);
    target.searchParams.set("state", p.get("state"));
    res.writeHead(302, { location: target.toString() });
    return res.end();
  }
  if (url.pathname === "/token" && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const form = new URLSearchParams(raw);
    const basic = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString();
    if (basic !== `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`) return json(res, 401, { error: "invalid_client" });
    const entry = codes.get(form.get("code"));
    codes.delete(form.get("code"));
    if (!entry || entry.redirect !== form.get("redirect_uri")) return json(res, 400, { error: "invalid_grant" });
    const verifier = form.get("code_verifier") ?? "";
    if (createHash("sha256").update(verifier).digest("base64url") !== entry.challenge) return json(res, 400, { error: "invalid_grant" });
    const now = Math.floor(Date.now() / 1000);
    return json(res, 200, {
      token_type: "Bearer", access_token: randomBytes(16).toString("hex"),
      id_token: idToken({ iss: issuer, aud: clientId, sub: "oidc-" + entry.email, email: entry.email, email_verified: true,
        name: "OIDC CI User", amr: ["pwd", "mfa"], nonce: entry.nonce, iat: now, exp: now + 300 })
    });
  }
  json(res, 404, { error: "not_found" });
}).listen(port, "127.0.0.1", () => console.log("fake OIDC provider on " + issuer));
