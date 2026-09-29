-- 03 · SÓLO LECTURA. Compara cada edificio copiado con su original.
-- Todas las columnas "_orig" y "_copia" tienen que coincidir.
SELECT c."canonicalName" AS edificio,
  (SELECT count(*) FROM "FixedExpense" f WHERE f."consortiumId" = o.id)          AS gf_orig,
  (SELECT count(*) FROM "FixedExpense" f WHERE f."consortiumId" = c.id)          AS gf_copia,
  (SELECT count(*) FROM "FixedExpense" f WHERE f."consortiumId" = c.id AND f."rubroId" IS NOT NULL) AS gf_con_rubro,
  (SELECT count(*) FROM "LspService" l WHERE l."consortiumId" = o.id)            AS serv_orig,
  (SELECT count(*) FROM "LspService" l WHERE l."consortiumId" = c.id)            AS serv_copia,
  (SELECT count(*) FROM "ConsortiumRubro" x WHERE x."consortiumId" = c.id)       AS rubros,
  (SELECT count(*) FROM "ConsortiumCoeficiente" x WHERE x."consortiumId" = c.id) AS coeficientes,
  (SELECT p.month || '/' || p.year FROM "Period" p WHERE p."consortiumId" = c.id AND p.status = 'ACTIVE') AS periodo
FROM "Consortium" c
JOIN "Client" dst ON dst.id = c."clientId" AND dst.email = 'EMAIL_DEL_CLIENTE_DE_PRUEBA'
JOIN "Client" src ON src.email = 'EMAIL_DE_MORINIGOADM'
JOIN "Consortium" o ON o."clientId" = src.id AND o."canonicalName" = c."canonicalName"
ORDER BY 1;
