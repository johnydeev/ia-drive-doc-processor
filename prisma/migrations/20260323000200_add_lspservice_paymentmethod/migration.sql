-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('DEBITO_AUTOMATICO', 'TRANSFERENCIA', 'EFECTIVO');

-- CreateTable
CREATE TABLE "LspService" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "consortiumId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "clientNumber" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LspService_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "lspServiceId" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "paymentMethod" "PaymentMethod";

-- CreateIndex
CREATE UNIQUE INDEX "LspService_consortiumId_provider_clientNumber_key" ON "LspService"("consortiumId", "provider", "clientNumber");
CREATE INDEX "LspService_clientId_provider_clientNumber_idx" ON "LspService"("clientId", "provider", "clientNumber");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_lspServiceId_fkey" FOREIGN KEY ("lspServiceId") REFERENCES "LspService"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LspService" ADD CONSTRAINT "LspService_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LspService" ADD CONSTRAINT "LspService_consortiumId_fkey" FOREIGN KEY ("consortiumId") REFERENCES "Consortium"("id") ON DELETE CASCADE ON UPDATE CASCADE;
