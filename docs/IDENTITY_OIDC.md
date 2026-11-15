# Enterprise SSO: standards-based OpenID Connect adapter

RAM includes a provider-agnostic OIDC relying party (`lib/auth/oidc.ts`, routes `/api/session/oidc/start` and `/api/session/oidc/callback`). It works with any compliant provider (Okta, Microsoft Entra ID, Google Workspace, Auth0, Keycloak, JumpCloud, ...). It is **off** until configured; demo sign-in for the public demo is independent and unaffected.

## Flow
Authorization Code + PKCE (S256), `state` and `nonce` in a signed, 10-minute, path-scoped httpOnly cookie. The code is exchanged with `client_secret_basic`. The ID token is verified against the provider JWKS (RS256/384/512, PS256/384, ES256/384 only; `none` and HMAC refused), with exact issuer, audience/azp, expiry, issued-at window and nonce. A hash of the ID token is recorded as a one-time assertion id (replay protection). Claims then go through the same account resolution as the signed-assertion boundary: existing linked identities sign in (membership and organization status re-checked), new verified emails enter onboarding, and SSO can never self-grant RAM staff roles.

MFA: with `RAM_IDENTITY_REQUIRE_MFA` (default true) the ID token must carry an MFA `amr` value (`mfa`, `otp`, `hwk`, ...) or an `acr` listed in `RAM_OIDC_MFA_ACR_VALUES` (also sent as `acr_values`).

## Configuration (Render env vars)
| Variable | Example | Notes |
| --- | --- | --- |
| `RAM_OIDC_ISSUER` | `https://acme.okta.com` | Must equal the discovery `issuer`. |
| `RAM_OIDC_CLIENT_ID` | from the IdP app | |
| `RAM_OIDC_CLIENT_SECRET` | from the IdP app | Secret; set only in Render. |
| `RAM_OIDC_REDIRECT_URI` | `https://<host>/api/session/oidc/callback` | Register this exact URI at the IdP. |
| `RAM_OIDC_PROVIDER_NAME` | `acme-okta` | Label stored on linked identities (default `oidc`). |
| `RAM_OIDC_SCOPES` | `openid email profile` | Default shown. |
| `RAM_OIDC_MFA_ACR_VALUES` | `urn:okta:loa:2fa:any` | Optional. |

When configured, `/signin` shows "Sign in with organization SSO" and the pilot-readiness identity checks pass via `identity_oidc`. Tests: `tests/oidc.test.ts`; live flow against a fake provider: `npm run e2e:oidc` (CI).
