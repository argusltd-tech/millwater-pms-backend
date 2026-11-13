-- Remote supply relay state for each meter.
ALTER TABLE "Meter" ADD COLUMN "relayState" TEXT NOT NULL DEFAULT 'connected';
ALTER TABLE "Meter" ADD COLUMN "relayReason" TEXT;
ALTER TABLE "Meter" ADD COLUMN "relayChangedAt" TIMESTAMP(3);
ALTER TABLE "Meter" ADD COLUMN "relayChangedById" TEXT;

ALTER TABLE "Meter" ADD CONSTRAINT "Meter_relayChangedById_fkey" FOREIGN KEY ("relayChangedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
