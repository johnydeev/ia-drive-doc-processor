-- El CUIT es la identidad real de un consorcio o proveedor: la razón social puede
-- cambiar (casamiento, cambio de denominación), el CUIT no. Dos registros del
-- mismo cliente compartiendo CUIT rompen el matching, que resuelve por CUIT con un
-- `.find()`: la boleta se le cuelga al primero que devuelva la base, sin orden
-- garantizado, y puede cambiar entre corridas.
--
-- Postgres trata los NULL como distintos entre sí, así que los proveedores sin
-- CUIT propio (SUTERH, FATERYH, ARCA) conviven sin problema bajo este índice.
--
-- Verificado antes de aplicar: 0 CUITs repetidos en los 186 proveedores y los 46
-- consorcios de MorinigoAdm, y ninguno repetido en el archivo ALTA.
CREATE UNIQUE INDEX "Provider_clientId_cuit_key" ON "Provider"("clientId", "cuit");
CREATE UNIQUE INDEX "Consortium_clientId_cuit_key" ON "Consortium"("clientId", "cuit");

-- El índice común sobre (clientId, cuit) queda cubierto por el unique nuevo.
DROP INDEX IF EXISTS "Provider_clientId_cuit_idx";
