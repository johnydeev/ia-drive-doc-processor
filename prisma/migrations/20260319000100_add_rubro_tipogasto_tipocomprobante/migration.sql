-- Enum TipoGasto
CREATE TYPE "TipoGasto" AS ENUM ('ORDINARIO', 'EXTRAORDINARIO', 'PARTICULAR');

-- Nueva tabla Rubro (a nivel consorcio, como Coeficiente)
CREATE TABLE "Rubro" (
    "id"           TEXT         NOT NULL,
    "clientId"     TEXT         NOT NULL,
    "consortiumId" TEXT         NOT NULL,
    "name"         TEXT         NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Rubro_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Rubro_consortiumId_name_key" ON "Rubro"("consortiumId", "name");
CREATE INDEX "Rubro_consortiumId_idx" ON "Rubro"("consortiumId");
ALTER TABLE "Rubro" ADD CONSTRAINT "Rubro_clientId_fkey"     FOREIGN KEY ("clientId")     REFERENCES "Client"("id")     ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Rubro" ADD CONSTRAINT "Rubro_consortiumId_fkey" FOREIGN KEY ("consortiumId") REFERENCES "Consortium"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Nuevas columnas en Invoice
ALTER TABLE "Invoice" ADD COLUMN "rubroId"         TEXT;
ALTER TABLE "Invoice" ADD COLUMN "tipoGasto"       "TipoGasto" NOT NULL DEFAULT 'ORDINARIO';
ALTER TABLE "Invoice" ADD COLUMN "tipoComprobante" TEXT;

-- FK Invoice -> Rubro
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_rubroId_fkey" FOREIGN KEY ("rubroId") REFERENCES "Rubro"("id") ON DELETE SET NULL ON UPDATE CASCADE;
