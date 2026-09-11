-- Métricas de consumo de IA — consultas de análisis (2026-08-31)
--
-- Se corren contra la base de producción (Supabase `invoices-ia-automation`).
-- Todas leen `ProcessingJob`, que tiene una fila por archivo procesado: es la
-- única tabla que también cubre las boletas que NO entraron. `TokenUsage` guarda
-- una fila por corrida y `Invoice` sólo las que entraron.
--
-- ⚠️ TECHO CORREGIDO CON DATOS REALES (2026-09-10). El comentario de abajo decía
-- "~20 requests/día por modelo → piso de referencia ~60/día". Medido sobre dos
-- jornadas completas (2026-09-08 y 09) el techo real es MÁS DEL DOBLE:
--   · ~34-40 requests/día POR MODELO  ·  ~91-107/día en total
--   · ~35 boletas/día entran limpias; pasada esa, cada una cuesta 5-6 requests
--   · las cuotas RPD se reinician a MEDIANOCHE DEL PACÍFICO = 04:00 en Argentina
--   · los límites son POR PROYECTO, no por API key (otra key del mismo proyecto
--     NO agrega cuota)
--
-- Contexto del techo (histórico): el free tier de Gemini daba ~20 requests/día POR MODELO y el
-- barrido usa 3 modelos, así que el piso de referencia son ~60 requests/día.
-- Volumen medido: 17,7 boletas/día promedio, p95 53,8, pico 72.


-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Requests por día contra el techo de ~60.
--    Si `requests` supera a `archivos`, el barrido está gastando de más: son
--    modelos agotados o 503 reintentados antes de resolver.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT "createdAt"::date                          AS dia,
       count(*)                                   AS archivos,
       sum("aiRequests")                          AS requests,
       round(avg("aiRequests"), 2)                AS requests_por_archivo,
       count(*) FILTER (WHERE "usedVision")       AS con_vision
FROM "ProcessingJob"
WHERE "aiRequests" IS NOT NULL
GROUP BY 1
ORDER BY 1 DESC;


-- ─────────────────────────────────────────────────────────────────────────────
-- 1b) Abierto por modelo: cuál de los tres baldes se vacía primero.
--     Un modelo que aparece mucho y no resuelve es cuota quemada.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT pj."createdAt"::date  AS dia,
       kv.key                AS modelo,
       sum(kv.value::int)    AS requests
FROM "ProcessingJob" pj,
     jsonb_each_text(pj."aiRequestsJson") AS kv
WHERE pj."aiRequestsJson" IS NOT NULL
GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Rebotes por categoría: separa "falta el alta en el directorio" (que ningún
--    reintento arregla) de "el papel no trae el CUIT" (candidato a fallback).
-- ─────────────────────────────────────────────────────────────────────────────
SELECT "reasonCategory",
       count(*)                             AS boletas,
       sum("aiRequests")                    AS requests,
       count(*) FILTER (WHERE "usedVision") AS con_vision
FROM "ProcessingJob"
WHERE outcome = 'unassigned'
GROUP BY 1
ORDER BY 2 DESC;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3) A dónde se va el gasto: requests por resultado final.
--    Acá se lee el overhead: todo lo que no es `ok` son requests que no
--    produjeron una boleta cargada.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT outcome,
       count(*)                    AS archivos,
       sum("aiRequests")           AS requests,
       round(avg("aiRequests"), 2) AS requests_prom
FROM "ProcessingJob"
WHERE outcome IS NOT NULL
GROUP BY 1
ORDER BY 3 DESC NULLS LAST;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4) Cuánto cuestan los reprocesos: mismo archivo procesado más de una vez.
--    Cada corrección (borrar desde Boletas entrantes) vuelve a pagar la
--    extracción completa.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT "driveFileId",
       max("driveFileName")  AS archivo,
       count(*)              AS pasadas,
       sum("aiRequests")     AS requests_totales
FROM "ProcessingJob"
WHERE outcome IS NOT NULL
GROUP BY 1
HAVING count(*) > 1
ORDER BY 4 DESC NULLS LAST;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5) CORTA-CORRIENTE (2026-09-10): cuántas boletas frenó el corte y qué gastaron.
--    CONTROL: `requests` tiene que dar 0 — el corte va ANTES de llamar a la IA.
--    Si da más que 0, el gate se está evaluando tarde y no ahorra nada.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT "createdAt"::date AS dia,
       count(*)          AS boletas_frenadas,
       sum("aiRequests") AS requests
FROM "ProcessingJob"
WHERE "reasonCategory" = 'circuit_open'
GROUP BY 1
ORDER BY 1 DESC;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5b) ¿Se resolvió el problema del SIN MONTO falso? Tras el corta-corriente,
--     `no_amount` tiene que bajar de ~12/día a los casos legítimos (documentos
--     que la IA SÍ leyó y no tenían monto: capturas de pantalla, etc.).
--     Un `no_amount` con 5-7 requests es la firma de la cadena caída.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT "createdAt"::date           AS dia,
       count(*)                    AS sin_monto,
       sum("aiRequests")           AS requests,
       round(avg("aiRequests"), 2) AS req_prom
FROM "ProcessingJob"
WHERE outcome = 'no_amount'
GROUP BY 1
ORDER BY 1 DESC;


-- ─────────────────────────────────────────────────────────────────────────────
-- 6) VEP POR TIPO (2026-09-11). Los cupones que no se pudieron clasificar van a
--    Revisión con 0 requests (`vep_mixto` / `vep_desconocido`); los de retención
--    sin fila en el ALTA van a Sin Asignar (`vep_retencion_not_registered`).
--    CONTROL: los dos primeros tienen que dar `requests = 0` — el gate corre
--    ANTES de la IA.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT "reasonCategory",
       count(*)          AS cupones,
       sum("aiRequests") AS requests
FROM "ProcessingJob"
WHERE "reasonCategory" IN ('vep_mixto', 'vep_desconocido', 'vep_retencion_not_registered')
GROUP BY 1
ORDER BY 2 DESC;


-- 6b) VEP de retención que SÍ entraron: boletas colgadas de una fila `VEP RETENCION`.
--     Tienen que salir con el proveedor = la empresa retenida (Libres, Dogo…), no ARCA.
SELECT c."canonicalName" AS consorcio,
       p."canonicalName" AS empresa_retenida,
       i."boletaNumber"  AS nro_vep,
       i.amount,
       i.detail,
       i."createdAt"::date AS dia
FROM "Invoice" i
JOIN "LspService" l ON l.id = i."lspServiceId"
JOIN "Consortium" c ON c.id = i."consortiumId"
LEFT JOIN "Provider" p ON p.id = i."providerId"
WHERE l."providerName" = 'VEP RETENCION'
ORDER BY i."createdAt" DESC;


-- ─────────────────────────────────────────────────────────────────────────────
-- CONTROL DE SANIDAD: los duplicados por hash tienen que dar `aiRequests = 0`,
-- porque `dedupHashStep` corre ANTES de la IA. Si dan más que 0, el contador
-- está registrando llamadas que no existen.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT outcome, min("aiRequests") AS minimo, max("aiRequests") AS maximo
FROM "ProcessingJob"
WHERE outcome = 'duplicate'
GROUP BY 1;
