-- Agregar providerId FK nullable a LspService
ALTER TABLE "LspService" ADD COLUMN "providerId" TEXT;
ALTER TABLE "LspService" ADD CONSTRAINT "LspService_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE SET NULL ON UPDATE CASCADE;
