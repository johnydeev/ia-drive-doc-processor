-- Vincular Receipt con Invoice (relación 1:1 opcional)
-- invoiceId es unique: una boleta solo puede tener un recibo de pago

ALTER TABLE "Receipt"
  ADD COLUMN IF NOT EXISTS "invoiceId" TEXT,
  ALTER COLUMN "amount"      DROP NOT NULL,
  ALTER COLUMN "paymentDate" DROP NOT NULL;

-- Índice único para la relación 1:1
CREATE UNIQUE INDEX IF NOT EXISTS "Receipt_invoiceId_key"
  ON "Receipt"("invoiceId");

-- Índice de búsqueda rápida por invoiceId
CREATE INDEX IF NOT EXISTS "Receipt_invoiceId_idx"
  ON "Receipt"("invoiceId");

-- FK hacia Invoice con SET NULL al borrar la boleta
ALTER TABLE "Receipt"
  ADD CONSTRAINT "Receipt_invoiceId_fkey"
  FOREIGN KEY ("invoiceId")
  REFERENCES "Invoice"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
