-- Tipo de documento (spec 2026-09-17): la factura del proveedor o la retención que
-- el consorcio le practica. Un gasto fijo espera uno u otro; una obligación sólo
-- acepta boletas de su tipo.
CREATE TYPE "DocKind" AS ENUM ('FACTURA', 'RETENCION');

ALTER TABLE "Invoice"      ADD COLUMN "docKind" "DocKind" NOT NULL DEFAULT 'FACTURA';
ALTER TABLE "FixedExpense" ADD COLUMN "kind"    "DocKind" NOT NULL DEFAULT 'FACTURA';

-- Backfill: las retenciones que ya entraron por LIQ_RETENCION (spec 2026-09-12).
UPDATE "Invoice" SET "docKind" = 'RETENCION' WHERE detail LIKE 'Retenciones s/fra.%';

-- Una obligación FACTURA que haya quedado colgada de una retención (el paquete llegó
-- antes que la factura; caso real Pueyrredón 2418 / Dogo 09/2026) se libera: vuelve
-- a PENDING y la factura la va a ocupar cuando llegue.
UPDATE "ExpenseObligation" o
SET "invoiceId" = NULL, status = 'PENDING', "updatedAt" = now()
FROM "Invoice" i, "FixedExpense" f
WHERE o."invoiceId" = i.id AND o."fixedExpenseId" = f.id
  AND i."docKind" = 'RETENCION' AND f.kind = 'FACTURA';

-- Un gasto fijo por objetivo, tipo y consorcio.
DROP INDEX "FixedExpense_consortiumId_providerId_key";
CREATE UNIQUE INDEX "FixedExpense_consortiumId_providerId_kind_key"
  ON "FixedExpense"("consortiumId", "providerId", "kind");
