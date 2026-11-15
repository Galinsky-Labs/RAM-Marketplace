/** Live E2E for the standards-based OIDC adapter against scripts/fake-oidc-provider.mjs. */
export {};
const base = process.env.RAM_E2E_BASE_URL ?? "http://127.0.0.1:3118";

function fail(message: string): never {
  throw new Error("OIDC E2E failed: " + message);
}
function cookie(response: Response, name: string) {
  const header = response.headers.getSetCookie?.() ?? [];
  const found = header.find((value) => value.startsWith(name + "="));
  return found ? found.split(";")[0] : "";
}

async function login() {
  const start = await fetch(base + "/api/session/oidc/start?next=/research", { redirect: "manual" });
  if (start.status !== 303) fail("start should redirect, got " + start.status + " " + await start.text());
  const stateCookie = cookie(start, "ram_oidc_state");
  if (!stateCookie) fail("state cookie missing");
  const authorize = await fetch(start.headers.get("location")!, { redirect: "manual" });
  if (authorize.status !== 302) fail("authorize should redirect");
  return { stateCookie, callback: authorize.headers.get("location")! };
}

const first = await login();
const callback = await fetch(first.callback, { headers: { Cookie: first.stateCookie }, redirect: "manual" });
if (callback.status !== 303) fail("callback should complete sign-in, got " + callback.status + " " + await callback.text());
const destination = callback.headers.get("location") ?? "";
if (!destination.includes("/onboarding?identity=verified")) fail("new verified identity should enter onboarding, got " + destination);
if (!cookie(callback, "ram_identity_enrollment")) fail("enrollment cookie missing");

const replay = await fetch(first.callback, { headers: { Cookie: first.stateCookie }, redirect: "manual" });
if (replay.status !== 401) fail("replayed authorization code must be rejected, got " + replay.status);

const second = await login();
const forged = new URL(second.callback);
forged.searchParams.set("state", "forged-state");
const badState = await fetch(forged, { headers: { Cookie: second.stateCookie }, redirect: "manual" });
if (badState.status !== 401) fail("state mismatch must be rejected");
const noCookie = await fetch(second.callback, { redirect: "manual" });
if (noCookie.status !== 401) fail("callback without state cookie must be rejected");

console.log("RAM OIDC E2E passed: discovery, PKCE code flow, RS256 ID token verification, enrollment, code replay and state forgery rejection.");
