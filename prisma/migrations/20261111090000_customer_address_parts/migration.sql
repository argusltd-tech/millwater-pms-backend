-- Structured customer address. "physicalAddress" stays as the one-line form built from these parts.
ALTER TABLE "Customer"
  ADD COLUMN "addressLine1" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "addressLine2" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "area" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "city" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "state" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "postCode" TEXT NOT NULL DEFAULT '';

-- Existing addresses keep their text in line 1 until someone completes the other parts.
UPDATE "Customer" SET "addressLine1" = "physicalAddress" WHERE "addressLine1" = '';
