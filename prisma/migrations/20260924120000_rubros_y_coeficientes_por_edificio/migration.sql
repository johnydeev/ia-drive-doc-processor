-- Rubros y coeficientes por edificio (spec 2026-09-24).
-- Todo aditivo y nullable: la aplicación anterior sigue funcionando contra este schema.

-- Capa 1: número de orden del rubro (3 SERVICIOS PÚBLICOS). Nullable, sin unique.
ALTER TABLE "Rubro" ADD COLUMN "order" INTEGER;

-- Capa 2: qué rubros del catálogo usa cada edificio.
CREATE TABLE "ConsortiumRubro" (
    "id" TEXT NOT NULL,
    "consortiumId" TEXT NOT NULL,
    "rubroId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsortiumRubro_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConsortiumRubro_consortiumId_rubroId_key" ON "ConsortiumRubro"("consortiumId", "rubroId");
CREATE INDEX "ConsortiumRubro_consortiumId_idx" ON "ConsortiumRubro"("consortiumId");

ALTER TABLE "ConsortiumRubro" ADD CONSTRAINT "ConsortiumRubro_consortiumId_fkey"
    FOREIGN KEY ("consortiumId") REFERENCES "Consortium"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConsortiumRubro" ADD CONSTRAINT "ConsortiumRubro_rubroId_fkey"
    FOREIGN KEY ("rubroId") REFERENCES "Rubro"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Capa 2: qué coeficientes usa cada edificio (las columnas de la liquidación).
CREATE TABLE "ConsortiumCoeficiente" (
    "id" TEXT NOT NULL,
    "consortiumId" TEXT NOT NULL,
    "coeficienteId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsortiumCoeficiente_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConsortiumCoeficiente_consortiumId_coeficienteId_key" ON "ConsortiumCoeficiente"("consortiumId", "coeficienteId");
CREATE INDEX "ConsortiumCoeficiente_consortiumId_idx" ON "ConsortiumCoeficiente"("consortiumId");

ALTER TABLE "ConsortiumCoeficiente" ADD CONSTRAINT "ConsortiumCoeficiente_consortiumId_fkey"
    FOREIGN KEY ("consortiumId") REFERENCES "Consortium"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConsortiumCoeficiente" ADD CONSTRAINT "ConsortiumCoeficiente_coeficienteId_fkey"
    FOREIGN KEY ("coeficienteId") REFERENCES "Coeficiente"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Capa 3: qué rubro y coeficiente lleva cada gasto fijo. Las boletas lo heredan.
ALTER TABLE "FixedExpense" ADD COLUMN "rubroId" TEXT;
ALTER TABLE "FixedExpense" ADD COLUMN "coeficienteId" TEXT;

CREATE INDEX "FixedExpense_rubroId_idx" ON "FixedExpense"("rubroId");
CREATE INDEX "FixedExpense_coeficienteId_idx" ON "FixedExpense"("coeficienteId");

ALTER TABLE "FixedExpense" ADD CONSTRAINT "FixedExpense_rubroId_fkey"
    FOREIGN KEY ("rubroId") REFERENCES "Rubro"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FixedExpense" ADD CONSTRAINT "FixedExpense_coeficienteId_fkey"
    FOREIGN KEY ("coeficienteId") REFERENCES "Coeficiente"("id") ON DELETE SET NULL ON UPDATE CASCADE;
