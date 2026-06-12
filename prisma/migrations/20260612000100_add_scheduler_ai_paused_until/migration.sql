-- Pausa automática del scheduler por cuota de IA agotada (circuit breaker).
-- Mientras "aiPausedUntil" > now(), el scheduler no encola boletas del cliente.
-- Independiente del toggle manual "enabled". La setea el worker al detectar 429
-- en todos los proveedores de IA; vence sola en el próximo reset de cuota.
ALTER TABLE "SchedulerState" ADD COLUMN "aiPausedUntil" TIMESTAMP(3);
