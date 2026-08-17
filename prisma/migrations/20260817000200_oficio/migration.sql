-- Oficio del proveedor: a qué se dedica (Pintor, Albañil, Energía…).
-- NO es el Rubro: el rubro divide las secciones de una liquidación y agrupa
-- varios oficios; el oficio identifica al proveedor uno por uno.
CREATE TABLE "Oficio" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Oficio_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Oficio_clientId_name_key" ON "Oficio"("clientId", "name");
CREATE INDEX "Oficio_clientId_idx" ON "Oficio"("clientId");

ALTER TABLE "Oficio" ADD CONSTRAINT "Oficio_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Borrar un oficio del catálogo deja a sus proveedores sin etiqueta, nunca los borra.
ALTER TABLE "Provider" ADD COLUMN "oficioId" TEXT;
CREATE INDEX "Provider_oficioId_idx" ON "Provider"("oficioId");

ALTER TABLE "Provider" ADD CONSTRAINT "Provider_oficioId_fkey"
  FOREIGN KEY ("oficioId") REFERENCES "Oficio"("id") ON DELETE SET NULL ON UPDATE CASCADE;
