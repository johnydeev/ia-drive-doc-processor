-- Traspaso al mes siguiente marcado en el mes de ORIGEN y aplicado al CERRAR el
-- período (spec 2026-08-20-obligaciones-por-periodo-design.md).
--
-- Se marca ahora y se mueve después porque el período destino todavía puede no
-- existir: se crea justamente al cerrar. Marcar primero evita tener que inventarlo
-- antes de tiempo.
--
-- Timestamp y no booleano: permite saber cuándo se marcó cada boleta y auditar qué
-- entró en una corrida de cierre.
ALTER TABLE "Invoice" ADD COLUMN "carryOverRequestedAt" TIMESTAMP(3);
