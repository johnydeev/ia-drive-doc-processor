-- Arrastre de boletas impagas al período siguiente.
--
-- CARRIED_OVER: la boleta llegó y no se pagó; se pasó al mes siguiente. La
-- obligación de origen conserva su invoiceId, así el período mantiene la
-- evidencia del atraso (transparencia ante los inquilinos).
ALTER TYPE "ObligationStatus" ADD VALUE 'CARRIED_OVER';

-- Período del que se arrastró la boleta (null = nació en su período) e importe
-- del 2° vencimiento, que se carga a mano: el pipeline extrae sólo el 1°.
ALTER TABLE "Invoice" ADD COLUMN "carriedFromPeriodId" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "lateAmount" DECIMAL(14,2);

CREATE INDEX "Invoice_carriedFromPeriodId_idx" ON "Invoice"("carriedFromPeriodId");

ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_carriedFromPeriodId_fkey"
  FOREIGN KEY ("carriedFromPeriodId") REFERENCES "Period"("id") ON DELETE SET NULL ON UPDATE CASCADE;
