import { NextRequest, NextResponse } from "next/server";
import { authorizationUrl, createLoginState, oidcConfig, sealLoginState } from "@/lib/auth/oidc";
import { getSessionSecret } from "@/lib/auth/session";
import { oidcDiscovery } from "@/lib/server/oidc";

const OIDC_STATE_COOKIE = "ram_oidc_state";

export async function GET(request: NextRequest) {
  let config;
  try {
    config = oidcConfig();
  } catch {
    return NextResponse.json({ error: "Enterprise SSO is misconfigured" }, { status: 503 });
  }
  if (!config) return NextResponse.json({ error: "Enterprise SSO is not configured" }, { status: 503 });
  try {
    const discovery = await oidcDiscovery(config);
    const login = createLoginState(request.nextUrl.searchParams.get("next") ?? "/");
    const response = NextResponse.redirect(authorizationUrl(config, discovery, login), 303);
    response.cookies.set(OIDC_STATE_COOKIE, sealLoginState(login, getSessionSecret()), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/session/oidc",
      maxAge: 600
    });
    return response;
  } catch {
    return NextResponse.json({ error: "Enterprise SSO provider is unavailable" }, { status: 502 });
  }
}
