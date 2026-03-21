-- Agrega campo de aliases al Consortium.
-- Almacena nombres alternativos del consorcio tal como aparecen
-- en facturas de servicios (Edesur, AySA, etc.) separados por |
-- Ej: "BROWN ALMTE AV 708|AV ALMIRANTE BROWN 706"
ALTER TABLE "Consortium" ADD COLUMN "aliases" TEXT;
