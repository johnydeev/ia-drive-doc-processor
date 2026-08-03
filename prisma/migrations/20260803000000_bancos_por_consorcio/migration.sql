-- Bancos por consorcio: catálogo a nivel cliente + datos de cuenta por edificio.
--
-- Contexto de los pasos destructivos (5 y 6):
--  - `Consortium.bank` era texto suelto que el pipeline LEÍA (hasta la columna O de
--    Sheets) pero que ningún código ESCRIBÍA → está en NULL en todas las filas. Los
--    pasos 2 y 4 igual preservan cualquier valor cargado a mano por Supabase Studio.
--  - `Consortium.paymentAlias` nació por simetría con Provider.paymentAlias sin
--    consumidor propio, y su columna en el archivo ALTA está vacía. Se recicla como
--    `bankAlias` (el alias CBU de la cuenta del consorcio) por rename, que preserva
--    los valores.

-- 1. Catálogo de bancos por cliente
CREATE TABLE "Bank" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'slate',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Bank_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Bank_clientId_name_key" ON "Bank"("clientId", "name");
CREATE INDEX "Bank_clientId_idx" ON "Bank"("clientId");

ALTER TABLE "Bank" ADD CONSTRAINT "Bank_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Backfill defensivo: si alguien cargó Consortium.bank a mano, esos valores se
--    convierten en filas del catálogo. Se espera 0 filas.
INSERT INTO "Bank" ("id", "clientId", "name", "color", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, "clientId", TRIM("bank"), 'slate', NOW(), NOW()
FROM (
    SELECT DISTINCT "clientId", "bank"
    FROM "Consortium"
    WHERE "bank" IS NOT NULL AND TRIM("bank") <> ''
) AS distinct_banks;

-- 3. Columnas nuevas en Consortium
ALTER TABLE "Consortium" ADD COLUMN "bankId" TEXT;
ALTER TABLE "Consortium" ADD COLUMN "cbu" TEXT;
ALTER TABLE "Consortium" ADD COLUMN "accountNumber" TEXT;
ALTER TABLE "Consortium" ADD COLUMN "branch" TEXT;
ALTER TABLE "Consortium" ADD COLUMN "accountType" TEXT;
ALTER TABLE "Consortium" ADD COLUMN "accountHolder" TEXT;

-- 4. Enlazar los consorcios con el banco backfilleado
UPDATE "Consortium" c
SET "bankId" = b."id"
FROM "Bank" b
WHERE b."clientId" = c."clientId"
  AND b."name" = TRIM(c."bank")
  AND c."bank" IS NOT NULL;

-- 5. Baja del campo de texto suelto
ALTER TABLE "Consortium" DROP COLUMN "bank";

-- 6. El alias del consorcio pasa a ser el alias CBU de su cuenta
ALTER TABLE "Consortium" RENAME COLUMN "paymentAlias" TO "bankAlias";

-- 7. FK del banco asignado. SET NULL: borrar un banco desasigna, no borra edificios.
ALTER TABLE "Consortium" ADD CONSTRAINT "Consortium_bankId_fkey"
    FOREIGN KEY ("bankId") REFERENCES "Bank"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 8. Índice de la FK (Prisma lo crea para relaciones opcionales consultadas por join)
CREATE INDEX "Consortium_bankId_idx" ON "Consortium"("bankId");
