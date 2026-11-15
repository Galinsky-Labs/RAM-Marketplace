import "server-only";
import { NextRequest, NextResponse } from "next/server";
import {
  attachEnrollmentIdentity,
  attachSession,
  clearEnrollmentIdentity
} from "@/lib/auth/session";
import { landingPageForRole } from "@/lib/onboarding";
import type { consumeExternalIdentity } from "@/lib/server/identity";

type Resolution = Awaited<ReturnType<typeof consumeExternalIdentity>>;

/** Shared post-authentication response for signed assertions and OIDC. */
export function externalSessionResponse(request: NextRequest, resolution: Resolution, next?: string) {
  if (resolution.kind === "SELECT_ORGANIZATION") {
    return NextResponse.json(
      { error: "Organization selection required", choices: resolution.choices },
      { status: 409 }
    );
  }

  if (resolution.kind === "ENROLLMENT") {
    const response = NextResponse.redirect(new URL("/onboarding?identity=verified", request.url), 303);
    return attachEnrollmentIdentity(response, {
      userId: resolution.userId,
      email: resolution.email,
      name: resolution.name,
      provider: resolution.provider,
      subject: resolution.subject
    });
  }

  const destination = resolution.operational
    ? next && next !== "/" ? next : landingPageForRole(resolution.principal.role)
    : "/account";
  const response = NextResponse.redirect(new URL(destination, request.url), 303);
  clearEnrollmentIdentity(response);
  return attachSession(response, resolution.principal);
}
