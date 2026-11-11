-- Bank accounts customers can be asked to pay into (managed by administrators in Settings).
CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BankAccount_bankName_accountNumber_key" ON "BankAccount"("bankName", "accountNumber");

ALTER TABLE "Customer" ADD COLUMN "bankAccountId" TEXT;
CREATE INDEX "Customer_bankAccountId_idx" ON "Customer"("bankAccountId");
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_bankAccountId_fkey"
    FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Carry over the single account previously entered in Settings, and keep existing customers on it.
INSERT INTO "BankAccount" ("id", "accountName", "accountNumber", "bankName", "updatedAt")
SELECT 'bank_' || md5(random()::text || clock_timestamp()::text),
       COALESCE(NULLIF("bankAccountName", ''), NULLIF("companyName", ''), 'Millwater Limited'),
       "bankAccountNumber", "bankName", CURRENT_TIMESTAMP
FROM "SystemSettings"
WHERE "id" = 1 AND "bankName" <> '' AND "bankAccountNumber" <> '';

UPDATE "Customer" SET "bankAccountId" = (SELECT "id" FROM "BankAccount" ORDER BY "createdAt" LIMIT 1)
WHERE "bankAccountId" IS NULL;
