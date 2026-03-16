-- CreateEnum
CREATE TYPE "PeriodStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateTable
CREATE TABLE "Consortium" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "rawName" TEXT NOT NULL,
    "cuit" TEXT,
    "cutoffDay" INTEGER NOT NULL DEFAULT 5,
    "driveFolderProcessedId" TEXT,
    "isAutoCreated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Consortium_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Provider" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "cuit" TEXT,
    "isAutoCreated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsortiumProvider" (
    "id" TEXT NOT NULL,
    "consortiumId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsortiumProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Period" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "consortiumId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "PeriodStatus" NOT NULL DEFAULT 'ACTIVE',
    "driveFolderId" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Period_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "consortiumId" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "providerId" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "periodId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Consortium_clientId_canonicalName_key" ON "Consortium"("clientId", "canonicalName");

-- CreateIndex
CREATE INDEX "Consortium_clientId_idx" ON "Consortium"("clientId");

-- CreateIndex
CREATE INDEX "Provider_clientId_cuit_idx" ON "Provider"("clientId", "cuit");

-- CreateIndex
CREATE INDEX "Provider_clientId_idx" ON "Provider"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsortiumProvider_consortiumId_providerId_key" ON "ConsortiumProvider"("consortiumId", "providerId");

-- CreateIndex
CREATE UNIQUE INDEX "Period_consortiumId_year_month_key" ON "Period"("consortiumId", "year", "month");

-- CreateIndex
CREATE INDEX "Period_consortiumId_status_idx" ON "Period"("consortiumId", "status");

-- AddForeignKey
ALTER TABLE "Consortium" ADD CONSTRAINT "Consortium_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Provider" ADD CONSTRAINT "Provider_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsortiumProvider" ADD CONSTRAINT "ConsortiumProvider_consortiumId_fkey" FOREIGN KEY ("consortiumId") REFERENCES "Consortium"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsortiumProvider" ADD CONSTRAINT "ConsortiumProvider_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Period" ADD CONSTRAINT "Period_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Period" ADD CONSTRAINT "Period_consortiumId_fkey" FOREIGN KEY ("consortiumId") REFERENCES "Consortium"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_consortiumId_fkey" FOREIGN KEY ("consortiumId") REFERENCES "Consortium"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "Period"("id") ON DELETE SET NULL ON UPDATE CASCADE;
