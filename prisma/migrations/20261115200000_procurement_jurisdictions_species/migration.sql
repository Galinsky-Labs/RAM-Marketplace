-- CreateTable
CREATE TABLE "JurisdictionActivation" (
    "id" TEXT NOT NULL,
    "stateCode" TEXT NOT NULL,
    "species" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "evidenceReference" TEXT NOT NULL,
    "proposedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "activatedAt" TIMESTAMP(3),
    "suspendedById" TEXT,
    "suspendedAt" TIMESTAMP(3),
    "suspendedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JurisdictionActivation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyerProcurementPolicy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "requirePurchaseOrder" BOOLEAN NOT NULL DEFAULT false,
    "singleApproverLimitCents" INTEGER NOT NULL DEFAULT 0,
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuyerProcurementPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "buyerOrganizationId" TEXT NOT NULL,
    "poNumber" TEXT NOT NULL,
    "costCenter" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requestedById" TEXT NOT NULL,
    "firstApproverId" TEXT,
    "secondApproverId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JurisdictionActivation_status_species_idx" ON "JurisdictionActivation"("status", "species");

-- CreateIndex
CREATE UNIQUE INDEX "JurisdictionActivation_stateCode_species_key" ON "JurisdictionActivation"("stateCode", "species");

-- CreateIndex
CREATE UNIQUE INDEX "BuyerProcurementPolicy_organizationId_key" ON "BuyerProcurementPolicy"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_orderId_key" ON "PurchaseOrder"("orderId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_buyerOrganizationId_status_idx" ON "PurchaseOrder"("buyerOrganizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_buyerOrganizationId_poNumber_key" ON "PurchaseOrder"("buyerOrganizationId", "poNumber");

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

