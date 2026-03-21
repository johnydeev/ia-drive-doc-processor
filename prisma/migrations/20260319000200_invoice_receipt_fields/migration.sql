-- Agrega campos de recibo de pago a Invoice
ALTER TABLE "Invoice" ADD COLUMN "receiptDriveFileId"  TEXT;
ALTER TABLE "Invoice" ADD COLUMN "receiptDriveFileUrl" TEXT;
