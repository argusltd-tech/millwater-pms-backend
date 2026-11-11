-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'approved', 'rejected', 'cancelled');

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "approverRole" "UserRole" NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'pending',
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT,
    "payload" JSONB NOT NULL,
    "details" JSONB NOT NULL,
    "requestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApprovalRequest_status_category_createdAt_idx" ON "ApprovalRequest"("status", "category", "createdAt");
CREATE INDEX "ApprovalRequest_entity_entityId_idx" ON "ApprovalRequest"("entity", "entityId");
CREATE INDEX "ApprovalRequest_requestedById_createdAt_idx" ON "ApprovalRequest"("requestedById", "createdAt");

-- One pending request per item (e.g. one pending change per tariff or payment).
CREATE UNIQUE INDEX "ApprovalRequest_one_pending_per_entity" ON "ApprovalRequest"("entity", "entityId") WHERE "status" = 'pending';

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
