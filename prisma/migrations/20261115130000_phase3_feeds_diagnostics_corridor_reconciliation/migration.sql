-- AlterTable
ALTER TABLE "SupplierBatchImport" ADD COLUMN     "promotedCaseIds" JSONB,
ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT;

-- AlterTable
ALTER TABLE "TransportAssignment" ADD COLUMN     "corridorDecision" TEXT,
ADD COLUMN     "corridorEnforced" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "corridorRuleDigest" TEXT,
ADD COLUMN     "corridorRuleId" TEXT,
ADD COLUMN     "corridorRuleRevision" INTEGER,
ADD COLUMN     "destinationState" TEXT,
ADD COLUMN     "originState" TEXT;

-- CreateTable
CREATE TABLE "DiagnosticReport" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalReportId" TEXT NOT NULL,
    "animalCaseId" TEXT NOT NULL,
    "testCode" TEXT NOT NULL,
    "testName" TEXT NOT NULL,
    "resultStatus" TEXT NOT NULL,
    "interpretation" TEXT NOT NULL,
    "reportable" BOOLEAN NOT NULL DEFAULT false,
    "reviewFlag" TEXT NOT NULL,
    "reportedAt" TIMESTAMP(3) NOT NULL,
    "specimenCollectedAt" TIMESTAMP(3),
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedById" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgementNote" TEXT,

    CONSTRAINT "DiagnosticReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentReconciliationRun" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "statementHash" TEXT NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "executionCount" INTEGER NOT NULL,
    "matched" INTEGER NOT NULL,
    "discrepancyCount" INTEGER NOT NULL,
    "ramSucceededCents" INTEGER NOT NULL,
    "providerSucceededCents" INTEGER NOT NULL,
    "reconciled" BOOLEAN NOT NULL,
    "discrepancies" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DiagnosticReport_animalCaseId_reportedAt_idx" ON "DiagnosticReport"("animalCaseId", "reportedAt");

-- CreateIndex
CREATE INDEX "DiagnosticReport_reviewFlag_acknowledgedAt_idx" ON "DiagnosticReport"("reviewFlag", "acknowledgedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DiagnosticReport_provider_externalReportId_key" ON "DiagnosticReport"("provider", "externalReportId");

-- CreateIndex
CREATE INDEX "PaymentReconciliationRun_provider_periodStart_idx" ON "PaymentReconciliationRun"("provider", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentReconciliationRun_provider_statementHash_key" ON "PaymentReconciliationRun"("provider", "statementHash");

-- AddForeignKey
ALTER TABLE "DiagnosticReport" ADD CONSTRAINT "DiagnosticReport_animalCaseId_fkey" FOREIGN KEY ("animalCaseId") REFERENCES "AnimalCase"("publicId") ON DELETE RESTRICT ON UPDATE CASCADE;

