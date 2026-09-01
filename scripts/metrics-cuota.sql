-- Métricas de consumo de IA — consultas de análisis (2026-08-31)
--
-- Se corren contra la base de producción (Supabase `invoices-ia-automation`).
-- Todas leen `ProcessingJob`, que tiene una fila por archivo procesado: es la
-- única tabla que también cubre las boletas que NO entraron. `TokenUsage` guarda
-- una fila por corrida y `Invoice` sólo las que entraron.
--
-- Contexto del techo: el free tier de Gemini da ~20 requests/día POR MODELO y el
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
-- CONTROL DE SANIDAD: los duplicados por hash tienen que dar `aiRequests = 0`,
-- porque `dedupHashStep` corre ANTES de la IA. Si dan más que 0, el contador
-- está registrando llamadas que no existen.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT outcome, min("aiRequests") AS minimo, max("aiRequests") AS maximo
FROM "ProcessingJob"
WHERE outcome = 'duplicate'
GROUP BY 1;
