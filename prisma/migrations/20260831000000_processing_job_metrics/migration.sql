-- Métricas de consumo de IA por archivo procesado (2026-08-31).
--
-- `TokenUsage` guarda una fila por CORRIDA y `Invoice` sólo existe para las
-- boletas que entraron, así que hasta ahora el gasto de una boleta que rebota no
-- se podía atribuir. `ProcessingJob` es la única tabla con una fila por archivo
-- procesado, entre o no entre.
--
-- Todas nullable: las filas viejas no las tienen, y un job que muere antes de
-- llegar al pipeline nunca las escribe.
ALTER TABLE "ProcessingJob"
  ADD COLUMN "outcome"        TEXT,
  ADD COLUMN "reasonCategory" TEXT,
  ADD COLUMN "aiRequests"     INTEGER,
  ADD COLUMN "usedVision"     BOOLEAN,
  ADD COLUMN "aiRequestsJson" JSONB;
