-- Default invoice prefix for Millwater PMS.
ALTER TABLE "SystemSettings" ALTER COLUMN "invoicePrefix" SET DEFAULT 'INV-MW';

-- Move settings that still use the previous default; customised prefixes are untouched.
UPDATE "SystemSettings" SET "invoicePrefix" = 'INV-MW' WHERE "invoicePrefix" = 'INV-GW';
