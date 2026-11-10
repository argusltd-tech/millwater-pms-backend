-- CreateTable
CREATE TABLE "SystemSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "companyName" TEXT NOT NULL DEFAULT '',
    "companyAddress" TEXT NOT NULL DEFAULT '',
    "rcNumber" TEXT NOT NULL DEFAULT '',
    "taxId" TEXT NOT NULL DEFAULT '',
    "bankName" TEXT NOT NULL DEFAULT '',
    "bankAccountName" TEXT NOT NULL DEFAULT '',
    "bankAccountNumber" TEXT NOT NULL DEFAULT '',
    "vatRatePct" DECIMAL(7,4) NOT NULL DEFAULT 7.5,
    "paymentTermsDays" INTEGER NOT NULL DEFAULT 21,
    "invoicePrefix" TEXT NOT NULL DEFAULT 'INV-GW',
    "amiBaseUrl" TEXT NOT NULL DEFAULT '',
    "amiTokenEncrypted" TEXT,
    "amiAllowInsecureHttp" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "SystemSettings_pkey" PRIMARY KEY ("id")
);

