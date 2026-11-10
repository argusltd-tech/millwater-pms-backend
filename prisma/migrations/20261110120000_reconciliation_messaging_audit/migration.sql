-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('queued', 'sent', 'delivered', 'failed');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "duplicateOfId" TEXT,
ADD COLUMN     "reversalReason" TEXT,
ADD COLUMN     "reversedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "after" JSONB,
ADD COLUMN     "before" JSONB;

-- CreateTable
CREATE TABLE "CustomerMessage" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "templateType" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'queued',
    "statusNote" TEXT,
    "sentById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerMessage_customerId_createdAt_idx" ON "CustomerMessage"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "CustomerMessage_status_idx" ON "CustomerMessage"("status");

-- CreateIndex
CREATE INDEX "Payment_bankReference_idx" ON "Payment"("bankReference");

-- CreateIndex
CREATE INDEX "Payment_customerId_idx" ON "Payment"("customerId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMessage" ADD CONSTRAINT "CustomerMessage_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMessage" ADD CONSTRAINT "CustomerMessage_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

