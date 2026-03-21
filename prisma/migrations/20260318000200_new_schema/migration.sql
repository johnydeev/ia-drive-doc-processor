-- Agrega todos los cambios del schema nuevos sobre la base que dejó el reset:
-- - driveFoldersJson en Client (reemplaza columnas individuales que nunca existieron en migraciones anteriores)
-- - issueDate, coeficienteId, isManual en Invoice
-- - alias en Provider
-- - Nueva tabla Coeficiente
-- - Nueva tabla Receipt
-- - Índice adicional en Invoice

-- 1. Reemplazar columnas de Drive en Client por JSON
ALTER TABLE "Client" DROP COLUMN IF EXISTS "driveFolderPending";
ALTER TABLE "Client" DROP COLUMN IF EXISTS "driveFolderProcessed";
ALTER TABLE "Client" DROP COLUMN IF EXISTS "driveFolderUnassigned";
ALTER TABLE "Client" DROP COLUMN IF EXISTS "driveFolderFailed";
ALTER TABLE "Client" DROP COLUMN IF EXISTS "driveFolderReceipts";
ALTER TABLE "Client" ADD COLUMN "driveFoldersJson" JSONB;

-- 2. Nuevos campos en Invoice
ALTER TABLE "Invoice" ADD COLUMN "issueDate"     TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN "coeficienteId" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "isManual"      BOOLEAN NOT NULL DEFAULT false;

-- 3. Nuevo campo en Provider
ALTER TABLE "Provider" ADD COLUMN "alias" TEXT;

-- 4. Nueva tabla Coeficiente
CREATE TABLE "Coeficiente" (
    "id"           TEXT          NOT NULL,
    "clientId"     TEXT          NOT NULL,
    "consortiumId" TEXT          NOT NULL,
    "name"         TEXT          NOT NULL,
    "value"        DECIMAL(10,6) NOT NULL,
    "createdAt"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Coeficiente_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Coeficiente_consortiumId_name_key" ON "Coeficiente"("consortiumId", "name");
CREATE INDEX "Coeficiente_consortiumId_idx" ON "Coeficiente"("consortiumId");
ALTER TABLE "Coeficiente" ADD CONSTRAINT "Coeficiente_clientId_fkey"     FOREIGN KEY ("clientId")      REFERENCES "Client"("id")     ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Coeficiente" ADD CONSTRAINT "Coeficiente_consortiumId_fkey" FOREIGN KEY ("consortiumId")  REFERENCES "Consortium"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. FK de Invoice -> Coeficiente
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_coeficienteId_fkey" FOREIGN KEY ("coeficienteId") REFERENCES "Coeficiente"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 6. Nueva tabla Receipt
CREATE TABLE "Receipt" (
    "id"            TEXT          NOT NULL,
    "clientId"      TEXT          NOT NULL,
    "consortiumId"  TEXT          NOT NULL,
    "providerId"    TEXT          NOT NULL,
    "periodId"      TEXT          NOT NULL,
    "driveFileId"   TEXT          NOT NULL,
    "driveFileName" TEXT,
    "driveFileUrl"  TEXT,
    "amount"        DECIMAL(14,2) NOT NULL,
    "paymentDate"   TIMESTAMP(3)  NOT NULL,
    "observation"   TEXT,
    "createdAt"     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Receipt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Receipt_clientId_idx"              ON "Receipt"("clientId");
CREATE INDEX "Receipt_consortiumId_periodId_idx" ON "Receipt"("consortiumId", "periodId");
CREATE INDEX "Receipt_providerId_idx"            ON "Receipt"("providerId");
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_clientId_fkey"     FOREIGN KEY ("clientId")     REFERENCES "Client"("id")     ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_consortiumId_fkey" FOREIGN KEY ("consortiumId") REFERENCES "Consortium"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_providerId_fkey"   FOREIGN KEY ("providerId")   REFERENCES "Provider"("id")  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_periodId_fkey"     FOREIGN KEY ("periodId")     REFERENCES "Period"("id")    ON DELETE CASCADE ON UPDATE CASCADE;

-- 7. Índice adicional en Invoice para consultas por período
CREATE INDEX IF NOT EXISTS "Invoice_consortiumId_periodId_idx" ON "Invoice"("consortiumId", "periodId");
