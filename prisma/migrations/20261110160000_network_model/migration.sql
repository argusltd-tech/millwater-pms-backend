-- CreateTable
CREATE TABLE "Substation" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "capacityMVA" DECIMAL(10,2) NOT NULL,
    "voltageInKV" DECIMAL(8,2) NOT NULL,
    "voltageOutKV" DECIMAL(8,2) NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Substation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feeder" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "substationId" TEXT NOT NULL,
    "voltageKV" DECIMAL(8,2) NOT NULL,
    "ratedAmps" DECIMAL(10,2) NOT NULL,
    "overcurrentThresholdA" DECIMAL(10,2) NOT NULL,
    "minPowerFactorThreshold" DECIMAL(5,4) NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Feeder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transformer" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "feederId" TEXT NOT NULL,
    "ratedKVA" DECIMAL(12,2) NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transformer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Substation_code_key" ON "Substation"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Feeder_code_key" ON "Feeder"("code");

-- CreateIndex
CREATE INDEX "Feeder_substationId_idx" ON "Feeder"("substationId");

-- CreateIndex
CREATE UNIQUE INDEX "Transformer_code_key" ON "Transformer"("code");

-- CreateIndex
CREATE INDEX "Transformer_feederId_idx" ON "Transformer"("feederId");

-- AddForeignKey
ALTER TABLE "Feeder" ADD CONSTRAINT "Feeder_substationId_fkey" FOREIGN KEY ("substationId") REFERENCES "Substation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transformer" ADD CONSTRAINT "Transformer_feederId_fkey" FOREIGN KEY ("feederId") REFERENCES "Feeder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

