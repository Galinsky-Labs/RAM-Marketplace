import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { createExternalIdentityAssertion } from "../lib/auth/external-assertion";

const base = process.env.RAM_E2E_BASE_URL ?? "http://127.0.0.1:3118";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(name + " is required");
  }
  return value;
}

const assertionSecret = requiredEnv("RAM_IDENTITY_ASSERTION_SECRET");
const connectionString = requiredEnv("DATABASE_URL");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString })
});

function fail(message: string): never {
  throw new Error(message);
}

function form(fields: Record<string, string>) {
  return new URLSearchParams(fields);
}

async function post(
  path: string,
  fields: Record<string, string>,
  options: { cookie?: string; origin?: string } = {}
) {
  const headers = new Headers();
  headers.set("Origin", options.origin ?? base);
  if (options.cookie) headers.set("Cookie", options.cookie);

  return fetch(base + path, {
    method: "POST",
    headers,
    body: form(fields),
    redirect: "manual"
  });
}

function cookieNamed(response: Response, name: string) {
  const header = response.headers.get("set-cookie") ?? "";
  const match = header.match(
    new RegExp("(?:^|,\\s*)" + name + "=([^;]+)")
  );
  if (!match) {
    fail("Expected " + name + " cookie; got: " + header);
  }
  return name + "=" + match[1];
}

function expectStatus(response: Response, status: number, label: string) {
  if (response.status !== status) {
    fail(label + " expected " + status + ", got " + response.status);
  }
}

function assertion(
  label: string,
  email: string,
  name: string,
  subject: string
) {
  const now = Math.floor(Date.now() / 1000);
  return createExternalIdentityAssertion(
    {
      v: 1,
      aud: "ram-marketplace",
      provider: "ci-idp",
      subject,
      email,
      name,
      emailVerified: true,
      mfa: true,
      amr: ["pwd", "mfa"],
      jti: "ci-" + label + "-" + now,
      iat: now,
      exp: now + 120
    },
    assertionSecret
  );
}

async function demoRamCookie() {
  const response = await post("/api/session/demo", { actor: "ram" });
  expectStatus(response, 303, "RAM demo login");
  return cookieNamed(response, "ram_session");
}

async function externalLogin(
  token: string,
  organizationId?: string
) {
  const response = await post(
    "/api/session/external",
    {
      assertion: token,
      ...(organizationId ? { organizationId } : {})
    },
    { origin: "https://identity.example.test" }
  );
  return response;
}

async function protectedResearchProbe(cookie: string) {
  return post("/api/research-needs", {}, { cookie });
}

async function membershipAction(
  ramCookie: string,
  membershipId: string,
  status: "ACTIVE" | "SUSPENDED" | "REVOKED",
  reason: string
) {
  const response = await post(
    "/api/ops/access/memberships/" + membershipId,
    { status, reason },
    { cookie: ramCookie }
  );
  expectStatus(response, 303, "membership " + status);
}

async function organizationAction(
  ramCookie: string,
  organizationId: string,
  action: "APPROVE" | "SUSPEND" | "REACTIVATE",
  extra: Record<string, string> = {}
) {
  const response = await post(
    "/api/ops/access/organizations/" + organizationId,
    { action, ...extra },
    { cookie: ramCookie }
  );
  expectStatus(response, 303, "organization " + action);
}

try {
  const ramCookie = await demoRamCookie();

  const scientistToken = assertion(
    "scientist",
    "scientist@demo.ram.invalid",
    "Dr. Maya Chen",
    "ci-scientist-subject"
  );

  const scientistLogin = await externalLogin(scientistToken);
  expectStatus(scientistLogin, 303, "external scientist login");
  if (
    new URL(scientistLogin.headers.get("location") ?? "/", base).pathname !==
    "/research"
  ) {
    fail("Active scientist should land in /research");
  }
  const scientistCookie = cookieNamed(scientistLogin, "ram_session");

  const replay = await externalLogin(scientistToken);
  expectStatus(replay, 401, "replayed external assertion");

  const scientistMembership = await prisma.membership.findFirst({
    where: {
      user: { email: "scientist@demo.ram.invalid" },
      role: "RESEARCH_PI"
    },
    select: {
      id: true,
      organizationId: true
    }
  });
  if (!scientistMembership) fail("Scientist membership not found");

  await membershipAction(
    ramCookie,
    scientistMembership.id,
    "SUSPENDED",
    "CI validates immediate durable-session revocation"
  );

  expectStatus(
    await protectedResearchProbe(scientistCookie),
    403,
    "same cookie after membership suspension"
  );

  await membershipAction(
    ramCookie,
    scientistMembership.id,
    "ACTIVE",
    "CI restores active membership after suspension test"
  );

  expectStatus(
    await protectedResearchProbe(scientistCookie),
    400,
    "same cookie after membership reactivation"
  );

  await organizationAction(
    ramCookie,
    scientistMembership.organizationId,
    "SUSPEND",
    { notes: "CI validates organization-level session revocation" }
  );

  expectStatus(
    await protectedResearchProbe(scientistCookie),
    403,
    "same cookie after organization suspension"
  );

  await organizationAction(
    ramCookie,
    scientistMembership.organizationId,
    "REACTIVATE"
  );

  expectStatus(
    await protectedResearchProbe(scientistCookie),
    400,
    "same cookie after organization reactivation"
  );

  const newcomerEmail = "new-verified-researcher@identity.ram.test";
  const newcomerToken = assertion(
    "newcomer",
    newcomerEmail,
    "New Verified Researcher",
    "ci-newcomer-subject"
  );

  const newcomerLogin = await externalLogin(newcomerToken);
  expectStatus(newcomerLogin, 303, "new verified identity login");
  if (
    new URL(newcomerLogin.headers.get("location") ?? "/", base).pathname !==
    "/onboarding"
  ) {
    fail("New verified identity should land in /onboarding");
  }
  const enrollmentCookie = cookieNamed(
    newcomerLogin,
    "ram_identity_enrollment"
  );

  const onboard = await post(
    "/api/onboarding",
    {
      name: "Ignored Unverified Name",
      email: "ignored@example.test",
      organizationName: "CI Pending Research Institution",
      organizationType: "RESEARCH_INSTITUTION"
    },
    { cookie: enrollmentCookie }
  );
  expectStatus(onboard, 303, "verified organization onboarding");
  const pendingCookie = cookieNamed(onboard, "ram_session");

  expectStatus(
    await protectedResearchProbe(pendingCookie),
    403,
    "pending organization operational access"
  );

  const newcomer = await prisma.user.findUnique({
    where: { email: newcomerEmail },
    include: {
      memberships: {
        include: {
          organization: true
        }
      }
    }
  });
  if (!newcomer || newcomer.memberships.length !== 1) {
    fail("Verified newcomer membership was not created");
  }

  const pendingOrganization = newcomer.memberships[0].organization;
  if (pendingOrganization.status !== "PENDING_VERIFICATION") {
    fail("New organization must begin pending verification");
  }

  await organizationAction(
    ramCookie,
    pendingOrganization.id,
    "APPROVE",
    {
      method: "CI_IDENTITY_AND_REGISTRY_CHECK",
      evidenceSummary:
        "CI verified the identity-bound onboarding record and organization lifecycle approval."
    }
  );

  expectStatus(
    await protectedResearchProbe(pendingCookie),
    400,
    "same cookie after organization approval"
  );

  const verification = await prisma.organizationVerification.findUnique({
    where: { organizationId: pendingOrganization.id }
  });
  if (verification?.decision !== "APPROVED") {
    fail("Organization approval record was not persisted");
  }


  // Draft-only compliance authoring: durable CAS revisions, tenant role denial and audit evidence.
  const draftInput = {
    ruleId: "ci-synthetic-rule-versioning",
    originState: "AA",
    destinationState: "BB",
    species: "Swine",
    conditionFamily: "Synthetic fixture",
    prohibited: true,
    rationale: "CI test only; not operational authorization",
    sourceReferences: ["ci-synthetic-reference"],
    effectiveFrom: "2026-01-01",
    effectiveUntil: "2026-12-31",
    authorId: "demo-ram-user"
  };
  async function saveDraft(cookie: string, input: typeof draftInput, expectedDigest?: string) {
    return fetch(base + "/api/ops/compliance/rules/drafts", {
      method: "POST",
      headers: { Origin: base, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ input, expectedDigest })
    });
  }
  const forbiddenDraft = await saveDraft(scientistCookie, draftInput);
  expectStatus(forbiddenDraft, 403, "non-RAM author rejected");
  const firstDraftResponse = await saveDraft(ramCookie, draftInput);
  expectStatus(firstDraftResponse, 201, "first compliance rule draft");
  const firstDraft = (await firstDraftResponse.json()).draft as { revision: number; digest: string; status: string };
  if (firstDraft.revision !== 1 || firstDraft.status !== "DRAFT") fail("First compliance rule must be a nonactive draft");
  const nextDraftResponse = await saveDraft(ramCookie, { ...draftInput, rationale: "Updated CI review text" }, firstDraft.digest);
  expectStatus(nextDraftResponse, 201, "second compliance rule draft");
  const nextDraft = (await nextDraftResponse.json()).draft as { revision: number; digest: string; status: string };
  if (nextDraft.revision !== 2 || nextDraft.status !== "DRAFT") fail("Revision must remain DRAFT");
  expectStatus(await saveDraft(ramCookie, draftInput, firstDraft.digest), 400, "stale digest cannot overwrite");
  const persisted = await prisma.complianceRuleDraftRevision.findMany({
    where: { ruleId: draftInput.ruleId }, orderBy: { revision: "asc" }
  });
  if (persisted.length !== 2 || persisted[0].digest !== firstDraft.digest ||
      persisted[1].digest !== nextDraft.digest) fail("Draft revision ledger is not append-only");
  const auditCount = await prisma.auditEvent.count({
    where: { entityType: "ComplianceRuleDraftRevision", entityId: draftInput.ruleId }
  });
  if (auditCount !== 2) fail("Each committed draft revision must have atomic audit evidence");

  // Rule publication: two-person rule and deny-by-default corridor evaluation.
  async function demoCookie(actor: string) {
    const response = await post("/api/session/demo", { actor });
    expectStatus(response, 303, actor + " demo login");
    return cookieNamed(response, "ram_session");
  }
  async function publish(cookie: string, revision: number, digest: string) {
    return fetch(base + "/api/ops/compliance/rules/publications", {
      method: "POST",
      headers: { Origin: base, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ ruleId: draftInput.ruleId, revision, digest })
    });
  }
  const complianceCookie = await demoCookie("compliance");
  expectStatus(await publish(ramCookie, nextDraft.revision, nextDraft.digest), 403, "author cannot self-publish");
  expectStatus(await publish(complianceCookie, nextDraft.revision, firstDraft.digest), 409, "stale digest cannot publish");
  expectStatus(await publish(scientistCookie, nextDraft.revision, nextDraft.digest), 403, "non-RAM cannot publish");
  expectStatus(await publish(complianceCookie, nextDraft.revision, nextDraft.digest), 201, "second reviewer publishes");
  expectStatus(await publish(complianceCookie, firstDraft.revision, firstDraft.digest), 409, "older revision cannot replace newer");
  const publications = await prisma.complianceRulePublication.findMany({ where: { ruleId: draftInput.ruleId } });
  if (publications.length !== 1 || publications[0].revision !== 2 || publications[0].publishedById === publications[0].authorUserId) {
    fail("Rule publication ledger must hold one second-reviewer publication");
  }

  // Enterprise API keys: organization-scoped, hashed, revocable, CSRF-independent.
  const farmerCookie = await demoCookie("farmer");
  const keyResponse = await fetch(base + "/api/farm/api-keys", {
    method: "POST",
    headers: { Origin: base, Cookie: farmerCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "ci-herd-system", scopes: ["supplier-batch:write", "supplier-batch:read"], ttlDays: 7 })
  });
  expectStatus(keyResponse, 201, "farm admin creates API key");
  const apiKey = (await keyResponse.json()).key as { id: string; token: string; prefix: string };
  const storedKey = await prisma.organizationApiKey.findUnique({ where: { id: apiKey.id } });
  if (!storedKey || storedKey.keyHash === apiKey.token || storedKey.keyHash.includes(apiKey.token)) {
    fail("API key plaintext must not be stored");
  }
  const batchBody = JSON.stringify({ batchKey: "ci-api-batch-0001", rows: [] });
  const emptyBatch = await fetch(base + "/api/farm/batch/import", {
    method: "POST", headers: { Authorization: "Bearer " + apiKey.token, "Content-Type": "application/json" }, body: batchBody
  });
  expectStatus(emptyBatch, 400, "API key reaches batch validation without browser origin");
  const readBatch = await fetch(base + "/api/farm/batch/import?batchKey=ci-api-batch-0001", {
    headers: { Authorization: "Bearer " + apiKey.token }
  });
  expectStatus(readBatch, 200, "API key reads batch status");
  const forgedKey = apiKey.token.slice(0, -4) + (apiKey.token.endsWith("AAAA") ? "BBBB" : "AAAA");
  expectStatus(await fetch(base + "/api/farm/batch/import?batchKey=ci-api-batch-0001", {
    headers: { Authorization: "Bearer " + forgedKey }
  }), 401, "forged API key rejected");
  expectStatus(await fetch(base + "/api/farm/api-keys?id=" + apiKey.id, {
    method: "DELETE", headers: { Origin: base, Cookie: farmerCookie }
  }), 200, "farm admin revokes API key");
  expectStatus(await fetch(base + "/api/farm/batch/import?batchKey=ci-api-batch-0001", {
    headers: { Authorization: "Bearer " + apiKey.token }
  }), 401, "revoked API key rejected");
  expectStatus(await fetch(base + "/api/farm/api-keys", {
    method: "POST",
    headers: { Origin: base, Cookie: scientistCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "should-fail", scopes: ["supplier-batch:write"] })
  }), 403, "non-supplier cannot mint API keys");

  console.log(
    "RAM identity lifecycle E2E passed: signed login, replay prevention, membership revocation, organization suspension, verified onboarding and approval."
  );
} finally {
  await prisma.$disconnect();
}
