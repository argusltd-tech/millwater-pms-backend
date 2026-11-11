-- Customer-service staff designated as a customer's support contacts.
CREATE TABLE "CustomerSupportAssignment" (
    "customerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerSupportAssignment_pkey" PRIMARY KEY ("customerId","userId")
);

CREATE INDEX "CustomerSupportAssignment_userId_idx" ON "CustomerSupportAssignment"("userId");

ALTER TABLE "CustomerSupportAssignment" ADD CONSTRAINT "CustomerSupportAssignment_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerSupportAssignment" ADD CONSTRAINT "CustomerSupportAssignment_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Email provider reference for messages that were actually sent (e.g. the Resend email id).
ALTER TABLE "CustomerMessage" ADD COLUMN "providerMessageId" TEXT;

-- Who signs the onboarding email.
ALTER TABLE "SystemSettings"
    ADD COLUMN "emailSignatoryName" TEXT NOT NULL DEFAULT 'H. Fash',
    ADD COLUMN "emailSignatoryTitle" TEXT NOT NULL DEFAULT 'Chief Operating Officer';
