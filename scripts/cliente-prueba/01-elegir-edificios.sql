-- 01 · SÓLO LECTURA. Edificios de MorinigoAdm con lo que tiene cada uno cargado,
-- para elegir los 3 que se copian al cliente de prueba (uno con A/B/C/EXTRA).
SELECT
  c."canonicalName"                                                        AS edificio,
  b.name                                                                   AS banco,
  (SELECT string_agg(k.code, ',' ORDER BY k.code)
     FROM "ConsortiumCoeficiente" x JOIN "Coeficiente" k ON k.id = x."coeficienteId"
    WHERE x."consortiumId" = c.id)                                         AS coeficientes,
  (SELECT count(*) FROM "ConsortiumRubro" x WHERE x."consortiumId" = c.id)  AS rubros,
  (SELECT count(*) FROM "FixedExpense" f WHERE f."consortiumId" = c.id AND f.active) AS gastos_fijos,
  (SELECT count(*) FROM "LspService" l WHERE l."consortiumId" = c.id)       AS servicios
FROM "Consortium" c
JOIN "Client" cl ON cl.id = c."clientId"
LEFT JOIN "Bank" b ON b.id = c."bankId"
WHERE cl.email = 'EMAIL_DE_MORINIGOADM'
ORDER BY (SELECT count(*) FROM "ConsortiumCoeficiente" x WHERE x."consortiumId" = c.id) DESC,
         gastos_fijos DESC;
