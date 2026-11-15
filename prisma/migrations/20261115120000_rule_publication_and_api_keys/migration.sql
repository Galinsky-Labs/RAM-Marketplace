-- CreateTable
CREATE TABLE "ComplianceRulePublication" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "digest" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "publishedById" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "ComplianceRulePublication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationApiKey" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "role" "MembershipRole" NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceRulePublication_digest_key" ON "ComplianceRulePublication"("digest");

-- CreateIndex
CREATE INDEX "ComplianceRulePublication_supersededAt_ruleId_idx" ON "ComplianceRulePublication"("supersededAt", "ruleId");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceRulePublication_ruleId_revision_key" ON "ComplianceRulePublication"("ruleId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationApiKey_prefix_key" ON "OrganizationApiKey"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationApiKey_keyHash_key" ON "OrganizationApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "OrganizationApiKey_organizationId_createdAt_idx" ON "OrganizationApiKey"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "OrganizationApiKey" ADD CONSTRAINT "OrganizationApiKey_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationApiKey" ADD CONSTRAINT "OrganizationApiKey_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

