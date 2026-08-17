-- Marca como SERVICIO a los proveedores que ya tienen al menos un LspService.
-- Deja el estado correcto desde el arranque, sin depender de que la hoja ALTA se
-- actualice primero. La fuente de verdad sigue siendo la columna E del ALTA: si
-- no dice SERVICIO, el próximo sync los devuelve a PROVEEDOR.
UPDATE "Provider" SET "providerType" = 'SERVICIO'
WHERE id IN (SELECT DISTINCT "providerId" FROM "LspService" WHERE "providerId" IS NOT NULL);
