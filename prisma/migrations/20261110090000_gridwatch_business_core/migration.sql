-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'network_ops', 'billing_specialist', 'finance_officer', 'customer_service');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "BillingCycleStatus" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "MeterReadingType" AS ENUM ('opening', 'closing');

-- CreateEnum
CREATE TYPE "MeterReadingStatus" AS ENUM ('pending', 'confirmed', 'rejected');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('draft', 'issued', 'paid', 'partial', 'overdue');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('unmatched', 'matched', 'partial', 'duplicate', 'reversed');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "department" TEXT NOT NULL DEFAULT 'Operations',
    "phone" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'customer_service',
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "enterpriseName" TEXT NOT NULL,
    "industrySector" TEXT NOT NULL,
    "contactPerson" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "physicalAddress" TEXT NOT NULL,
    "feederId" TEXT NOT NULL,
    "transformerId" TEXT NOT NULL,
    "tariffScheduleId" TEXT NOT NULL,
    "contractedDemandKVA" DECIMAL(14,3) NOT NULL,
    "creditLimit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "riskRating" TEXT NOT NULL DEFAULT 'low',
    "communicationPreference" TEXT NOT NULL DEFAULT 'email',
    "onboardingDate" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Meter" (
    "id" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "feederId" TEXT NOT NULL,
    "transformerId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "commStatus" TEXT NOT NULL DEFAULT 'offline',
    "maxDemandKVA" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "powerFactor" DECIMAL(5,4) NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Meter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TariffSchedule" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "customerClass" TEXT NOT NULL,
    "peakRatePerKWh" DECIMAL(18,4) NOT NULL,
    "shoulderRatePerKWh" DECIMAL(18,4) NOT NULL,
    "offPeakRatePerKWh" DECIMAL(18,4) NOT NULL,
    "demandChargePerKVA" DECIMAL(18,4) NOT NULL,
    "serviceChargeMonthly" DECIMAL(18,2) NOT NULL,
    "minPowerFactor" DECIMAL(5,4) NOT NULL,
    "powerFactorPenaltyPerUnit" DECIMAL(18,2) NOT NULL,
    "taxRatePct" DECIMAL(7,4) NOT NULL,
    "fuelAdjustmentPerKWh" DECIMAL(18,4) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TariffSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingCycle" (
    "id" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "status" "BillingCycleStatus" NOT NULL DEFAULT 'open',
    "createdById" TEXT NOT NULL,
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeterReading" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "meterId" TEXT NOT NULL,
    "billingCycleId" TEXT NOT NULL,
    "reading" DECIMAL(20,4) NOT NULL,
    "readingDate" DATE NOT NULL,
    "readingType" "MeterReadingType" NOT NULL,
    "status" "MeterReadingStatus" NOT NULL DEFAULT 'confirmed',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeterReading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "meterId" TEXT NOT NULL,
    "tariffScheduleId" TEXT NOT NULL,
    "billingCycleId" TEXT NOT NULL,
    "billingPeriodStart" DATE NOT NULL,
    "billingPeriodEnd" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "previousReadKWh" DECIMAL(20,4) NOT NULL,
    "currentReadKWh" DECIMAL(20,4) NOT NULL,
    "totalConsumptionKWh" DECIMAL(20,4) NOT NULL,
    "peakKWh" DECIMAL(20,4) NOT NULL,
    "shoulderKWh" DECIMAL(20,4) NOT NULL,
    "offPeakKWh" DECIMAL(20,4) NOT NULL,
    "maxDemandKVA" DECIMAL(14,3) NOT NULL,
    "averagePowerFactor" DECIMAL(5,4) NOT NULL,
    "subtotal" DECIMAL(18,2) NOT NULL,
    "fuelAdjustment" DECIMAL(18,2) NOT NULL,
    "taxes" DECIMAL(18,2) NOT NULL,
    "totalAmount" DECIMAL(18,2) NOT NULL,
    "amountPaid" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "balanceDue" DECIMAL(18,2) NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'draft',
    "issueDate" DATE,
    "issuedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLineItem" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(20,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "rate" DECIMAL(18,4) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "InvoiceLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "transactionRef" TEXT NOT NULL,
    "bankReference" TEXT NOT NULL,
    "paymentDate" DATE NOT NULL,
    "valueDate" DATE NOT NULL,
    "payerName" TEXT NOT NULL,
    "customerId" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "channel" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'unmatched',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAllocation" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_accountNumber_key" ON "Customer"("accountNumber");

-- CreateIndex
CREATE INDEX "Customer_enterpriseName_idx" ON "Customer"("enterpriseName");

-- CreateIndex
CREATE INDEX "Customer_tariffScheduleId_isActive_idx" ON "Customer"("tariffScheduleId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Meter_serialNumber_key" ON "Meter"("serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Meter_customerId_key" ON "Meter"("customerId");

-- CreateIndex
CREATE INDEX "Meter_feederId_idx" ON "Meter"("feederId");

-- CreateIndex
CREATE UNIQUE INDEX "TariffSchedule_code_key" ON "TariffSchedule"("code");

-- CreateIndex
CREATE UNIQUE INDEX "BillingCycle_periodKey_key" ON "BillingCycle"("periodKey");

-- CreateIndex
CREATE INDEX "BillingCycle_status_startDate_idx" ON "BillingCycle"("status", "startDate");

-- CreateIndex
CREATE INDEX "MeterReading_customerId_readingDate_idx" ON "MeterReading"("customerId", "readingDate");

-- CreateIndex
CREATE UNIQUE INDEX "MeterReading_meterId_billingCycleId_readingType_key" ON "MeterReading"("meterId", "billingCycleId", "readingType");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_invoiceNumber_key" ON "Invoice"("invoiceNumber");

-- CreateIndex
CREATE INDEX "Invoice_status_dueDate_idx" ON "Invoice"("status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_customerId_billingCycleId_key" ON "Invoice"("customerId", "billingCycleId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_transactionRef_key" ON "Payment"("transactionRef");

-- CreateIndex
CREATE INDEX "Payment_status_paymentDate_idx" ON "Payment"("status", "paymentDate");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAllocation_paymentId_invoiceId_key" ON "PaymentAllocation"("paymentId", "invoiceId");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_createdAt_idx" ON "AuditLog"("entity", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_tariffScheduleId_fkey" FOREIGN KEY ("tariffScheduleId") REFERENCES "TariffSchedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meter" ADD CONSTRAINT "Meter_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingCycle" ADD CONSTRAINT "BillingCycle_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingCycle" ADD CONSTRAINT "BillingCycle_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterReading" ADD CONSTRAINT "MeterReading_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterReading" ADD CONSTRAINT "MeterReading_meterId_fkey" FOREIGN KEY ("meterId") REFERENCES "Meter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterReading" ADD CONSTRAINT "MeterReading_billingCycleId_fkey" FOREIGN KEY ("billingCycleId") REFERENCES "BillingCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterReading" ADD CONSTRAINT "MeterReading_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_meterId_fkey" FOREIGN KEY ("meterId") REFERENCES "Meter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tariffScheduleId_fkey" FOREIGN KEY ("tariffScheduleId") REFERENCES "TariffSchedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_billingCycleId_fkey" FOREIGN KEY ("billingCycleId") REFERENCES "BillingCycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLineItem" ADD CONSTRAINT "InvoiceLineItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
