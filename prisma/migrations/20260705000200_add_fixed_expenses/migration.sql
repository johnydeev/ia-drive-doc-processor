-- CreateEnum
CREATE TYPE "ObligationStatus" AS ENUM ('PENDING', 'RECEIVED', 'SKIPPED', 'NOT_RECEIVED');

-- CreateTable
CREATE TABLE "FixedExpense" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "consortiumId" TEXT NOT NULL,
    "providerId" TEXT,
    "lspServiceId" TEXT,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FixedExpense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseObligation" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "consortiumId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "fixedExpenseId" TEXT NOT NULL,
    "status" "ObligationStatus" NOT NULL DEFAULT 'PENDING',
    "invoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExpenseObligation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FixedExpense_clientId_idx" ON "FixedExpense"("clientId");
CREATE INDEX "FixedExpense_consortiumId_idx" ON "FixedExpense"("consortiumId");
CREATE UNIQUE INDEX "ExpenseObligation_invoiceId_key" ON "ExpenseObligation"("invoiceId");
CREATE UNIQUE INDEX "ExpenseObligation_periodId_fixedExpenseId_key" ON "ExpenseObligation"("periodId", "fixedExpenseId");
CREATE INDEX "ExpenseObligation_clientId_idx" ON "ExpenseObligation"("clientId");
CREATE INDEX "ExpenseObligation_periodId_status_idx" ON "ExpenseObligation"("periodId", "status");

-- AddForeignKey
ALTER TABLE "FixedExpense" ADD CONSTRAINT "FixedExpense_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FixedExpense" ADD CONSTRAINT "FixedExpense_consortiumId_fkey" FOREIGN KEY ("consortiumId") REFERENCES "Consortium"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FixedExpense" ADD CONSTRAINT "FixedExpense_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FixedExpense" ADD CONSTRAINT "FixedExpense_lspServiceId_fkey" FOREIGN KEY ("lspServiceId") REFERENCES "LspService"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExpenseObligation" ADD CONSTRAINT "ExpenseObligation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExpenseObligation" ADD CONSTRAINT "ExpenseObligation_consortiumId_fkey" FOREIGN KEY ("consortiumId") REFERENCES "Consortium"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExpenseObligation" ADD CONSTRAINT "ExpenseObligation_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "Period"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExpenseObligation" ADD CONSTRAINT "ExpenseObligation_fixedExpenseId_fkey" FOREIGN KEY ("fixedExpenseId") REFERENCES "FixedExpense"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExpenseObligation" ADD CONSTRAINT "ExpenseObligation_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
