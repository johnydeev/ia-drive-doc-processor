-- Corrida selectiva con diagnóstico: marca los jobs elegidos a mano por el owner
-- y guarda el diagnóstico de cada boleta hasta consolidarlo en el reporte de Drive.
ALTER TABLE "ProcessingJob" ADD COLUMN "diagnosticRunId" TEXT;
ALTER TABLE "ProcessingJob" ADD COLUMN "diagnosticsJson" JSONB;

CREATE INDEX "ProcessingJob_diagnosticRunId_idx" ON "ProcessingJob"("diagnosticRunId");
