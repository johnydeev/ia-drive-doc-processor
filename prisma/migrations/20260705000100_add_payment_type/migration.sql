-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('TOTAL', 'LIBRE', 'CUOTA');

-- AlterTable: nueva columna con default LIBRE (las filas nuevas la setea la app)
ALTER TABLE "Payment" ADD COLUMN "paymentType" "PaymentType" NOT NULL DEFAULT 'LIBRE';

-- Backfill del stock existente:
-- 1) Todo pago con cuotas es CUOTA.
UPDATE "Payment" SET "paymentType" = 'CUOTA' WHERE "totalInstallments" IS NOT NULL;

-- 2) Pago único (sin cuotas) cuyo monto cubre el total de la boleta → TOTAL.
UPDATE "Payment" p SET "paymentType" = 'TOTAL'
FROM "Invoice" i
WHERE p."invoiceId" = i.id
  AND p."totalInstallments" IS NULL
  AND i.amount IS NOT NULL
  AND p.amount >= i.amount;

-- 3) El resto queda LIBRE (default).
