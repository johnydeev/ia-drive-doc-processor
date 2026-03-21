-- Migration: Rubro y Coeficiente pasan a nivel cliente (catálogo compartido)
-- Antes: ambos modelos tenían consortiumId como FK obligatoria
-- Ahora: solo clientId, se comparten entre todos los consorcios del cliente

-- ============================================================
-- COEFICIENTE
-- ============================================================

-- Agregar columna code (identificador corto: A, B, C)
ALTER TABLE "Coeficiente" ADD COLUMN "code" TEXT;

-- Poblar code con el nombre existente para no perder datos
UPDATE "Coeficiente" SET "code" = "name" WHERE "code" IS NULL;

-- Hacer code NOT NULL después de poblar
ALTER TABLE "Coeficiente" ALTER COLUMN "code" SET NOT NULL;

-- Hacer value nullable (era NOT NULL antes)
ALTER TABLE "Coeficiente" ALTER COLUMN "value" DROP NOT NULL;

-- Eliminar unique constraint viejo
DROP INDEX IF EXISTS "Coeficiente_consortiumId_name_key";

-- Agregar nuevo unique constraint a nivel cliente
CREATE UNIQUE INDEX "Coeficiente_clientId_code_key" ON "Coeficiente"("clientId", "code");

-- Eliminar índice viejo
DROP INDEX IF EXISTS "Coeficiente_consortiumId_idx";

-- Agregar índice nuevo (clientId ya indexado implícitamente por FK)
CREATE INDEX "Coeficiente_clientId_idx" ON "Coeficiente"("clientId");

-- Eliminar FK a Consortium
ALTER TABLE "Coeficiente" DROP CONSTRAINT IF EXISTS "Coeficiente_consortiumId_fkey";

-- Eliminar columna consortiumId
ALTER TABLE "Coeficiente" DROP COLUMN IF EXISTS "consortiumId";

-- ============================================================
-- RUBRO
-- ============================================================

-- Agregar columna description (opcional)
ALTER TABLE "Rubro" ADD COLUMN "description" TEXT;

-- Eliminar unique constraint viejo
DROP INDEX IF EXISTS "Rubro_consortiumId_name_key";

-- Agregar nuevo unique constraint a nivel cliente
CREATE UNIQUE INDEX "Rubro_clientId_name_key" ON "Rubro"("clientId", "name");

-- Eliminar índice viejo
DROP INDEX IF EXISTS "Rubro_consortiumId_idx";

-- Agregar índice nuevo
CREATE INDEX "Rubro_clientId_idx" ON "Rubro"("clientId");

-- Eliminar FK a Consortium
ALTER TABLE "Rubro" DROP CONSTRAINT IF EXISTS "Rubro_consortiumId_fkey";

-- Eliminar columna consortiumId
ALTER TABLE "Rubro" DROP COLUMN IF EXISTS "consortiumId";

-- ============================================================
-- SCHEDULERSTATE
-- ============================================================

ALTER TABLE "SchedulerState" ADD COLUMN "lastDirectorySyncAt" TIMESTAMP(3);
