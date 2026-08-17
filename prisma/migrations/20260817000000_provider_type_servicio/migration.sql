-- Tercer tipo de proveedor: empresa de servicios (Edesur, AySA, Metrogas…).
-- Va SOLO en esta migración: Postgres no permite usar un valor de enum dentro de
-- la misma transacción que lo agregó, y Prisma corre cada migración en una.
-- El backfill va en la migración siguiente.
ALTER TYPE "ProviderType" ADD VALUE 'SERVICIO';
