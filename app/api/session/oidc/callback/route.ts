import { NextRequest, NextResponse } from "next/server";
import { claimsToAssertion, constantTimeEqual, oidcConfig, openLoginState, verifyIdToken } from "@/lib/auth/oidc";
import { getSessionSecret } from "@/lib/auth/session";
import { consumeExternalIdentity } from "@/lib/server/identity";
import { externalSessionResponse } from "@/lib/server/external-session";
import { exchangeCode, oidcDiscovery, oidcJwks } from "@/lib/server/oidc";
import { enforceRequestRateLimit, RateLimitExceededError } from "@/lib/server/rate-limit";

const OIDC_STATE_COOKIE = "ram_oidc_state";

function clearState(response: NextResponse) {
  response.cookies.set(OIDC_STATE_COOKIE, "", { path: "/api/session/oidc", maxAge: 0 });
  return response;
}

export async function GET(request: NextRequest) {
  let config;
  try {
    config = oidcConfig();
  } catch {
    return NextResponse.json({ error: "Enterprise SSO is misconfigured" }, { status: 503 });
  }
  if (!config) return NextResponse.json({ error: "Enterprise SSO is not configured" }, { status: 503 });

  try {
    await enforceRequestRateLimit(request, { action: "oidc_callback", limit: 60, windowSeconds: 600 });
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      return NextResponse.json({ error: error.message }, { status: 429, headers: { "Retry-After": String(error.retryAfterSeconds) } });
    }
    throw error;
  }

  const params = request.nextUrl.searchParams;
  if (params.get("error")) {
    return clearState(NextResponse.json({ error: "Identity provider returned an error" }, { status: 401 }));
  }
  try {
    const login = openLoginState(request.cookies.get(OIDC_STATE_COOKIE)?.value, getSessionSecret());
    const state = params.get("state") ?? "";
    const code = params.get("code") ?? "";
    if (!state || !constantTimeEqual(state, login.state)) throw new Error("OIDC state mismatch");
    if (!code || code.length > 2048) throw new Error("OIDC authorization code is missing");

    const discovery = await oidcDiscovery(config);
    const idToken = await exchangeCode(config, discovery, code, login.codeVerifier);
    let claims;
    try {
      claims = verifyIdToken(idToken, await oidcJwks(discovery), config, login.nonce);
    } catch (error) {
      // Provider key rotation: retry once with a fresh JWKS.
      if (!(error instanceof Error) || !/signing key|signature/.test(error.message)) throw error;
      claims = verifyIdToken(idToken, await oidcJwks(discovery, true), config, login.nonce);
    }
    const assertion = claimsToAssertion(config, claims, idToken);
    const resolution = await consumeExternalIdentity(assertion);
    return clearState(externalSessionResponse(request, resolution, login.next));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Enterprise SSO sign-in failed";
    const status = /Forbidden/.test(message) ? 403 : /provider HTTP|unavailable/.test(message) ? 502 : 401;
    return clearState(NextResponse.json({ error: message }, { status }));
  }
}
