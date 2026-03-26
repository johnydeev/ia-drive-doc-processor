-- AlterTable: add batchSize to Client
ALTER TABLE "Client" ADD COLUMN "batchSize" INTEGER NOT NULL DEFAULT 10;

-- AlterTable: add token tracking fields to Invoice
ALTER TABLE "Invoice" ADD COLUMN "tokensInput" INTEGER;
ALTER TABLE "Invoice" ADD COLUMN "tokensOutput" INTEGER;
ALTER TABLE "Invoice" ADD COLUMN "tokensTotal" INTEGER;
ALTER TABLE "Invoice" ADD COLUMN "aiProvider" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "aiModel" TEXT;
