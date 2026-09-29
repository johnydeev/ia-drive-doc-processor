-- 02 · COPIA 3 edificios de MorinigoAdm a un cliente de prueba VACÍO.
--
-- Antes de correrlo:
--   1. `npm run db:backup`
--   2. Crear el cliente de prueba desde el panel de admin (queda sin edificios).
--   3. Completar los 2 valores de abajo: EMAIL_DEL_CLIENTE_DE_PRUEBA y los 3 edificios.
--
-- Qué hace: SÓLO INSERTA en el cliente de prueba. No actualiza ni borra nada de
-- MorinigoAdm. Va en una transacción: si cualquier chequeo falla, no queda nada.
--
-- Copia: catálogos (rubros con su número, coeficientes, oficios, TODOS los
-- proveedores para que cualquier boleta matchee), los bancos de esos edificios,
-- los 3 edificios con su cuenta bancaria, sus servicios (LspService), los rubros y
-- coeficientes que usa cada uno, sus gastos fijos con rubro/coeficiente, y su
-- período ACTIVO. Las obligaciones del mes las genera sola la vista de
-- Obligaciones al abrirla.
-- NO copia: boletas, pagos, ni las carpetas de Rendiciones (apuntan al Drive de
-- MorinigoAdm: el cliente de prueba crea las suyas en SU Drive).

BEGIN;

CREATE TEMP TABLE _p ON COMMIT DROP AS
SELECT
  (SELECT id FROM "Client" WHERE email = 'EMAIL_DE_MORINIGOADM')      AS src,
  (SELECT id FROM "Client" WHERE email = 'EMAIL_DEL_CLIENTE_DE_PRUEBA')   AS dst;

CREATE TEMP TABLE _edif ON COMMIT DROP AS
SELECT c.*
FROM "Consortium" c, _p
WHERE c."clientId" = _p.src
  AND c."canonicalName" IN ('ARENALES 2154', 'EDIFICIO_2', 'EDIFICIO_3');

DO $$
DECLARE s text; d text; n int;
BEGIN
  SELECT src, dst INTO s, d FROM _p;
  IF s IS NULL THEN RAISE EXCEPTION 'No encuentro MorinigoAdm: revisá su email'; END IF;
  IF d IS NULL THEN RAISE EXCEPTION 'No encuentro el cliente de prueba: revisá el email'; END IF;
  IF s = d THEN RAISE EXCEPTION 'Origen y destino son el mismo cliente'; END IF;
  SELECT count(*) INTO n FROM _edif;
  IF n <> 3 THEN RAISE EXCEPTION 'Esperaba 3 edificios y encontré % (revisá los nombres)', n; END IF;
  SELECT count(*) INTO n FROM "Consortium" WHERE "clientId" = d;
  IF n > 0 THEN RAISE EXCEPTION 'El cliente de prueba ya tiene % edificios: el script es para uno vacío', n; END IF;
END $$;

-- ── Catálogos ─────────────────────────────────────────────────────────────
INSERT INTO "Rubro" (id, "clientId", name, description, "order", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, _p.dst, r.name, r.description, r."order", now(), now()
FROM "Rubro" r, _p WHERE r."clientId" = _p.src
ON CONFLICT DO NOTHING;

INSERT INTO "Coeficiente" (id, "clientId", code, name, value, "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, _p.dst, k.code, k.name, k.value, now(), now()
FROM "Coeficiente" k, _p WHERE k."clientId" = _p.src
ON CONFLICT DO NOTHING;

INSERT INTO "Oficio" (id, "clientId", name, description, "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, _p.dst, o.name, o.description, now(), now()
FROM "Oficio" o, _p WHERE o."clientId" = _p.src
ON CONFLICT DO NOTHING;

INSERT INTO "Bank" (id, "clientId", name, color, "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, _p.dst, b.name, b.color, now(), now()
FROM "Bank" b, _p
WHERE b.id IN (SELECT "bankId" FROM _edif WHERE "bankId" IS NOT NULL)
ON CONFLICT DO NOTHING;

-- Todos los proveedores: así cualquier boleta de prueba encuentra su proveedor.
INSERT INTO "Provider" (id, "clientId", "canonicalName", cuit, "matchNames", "paymentAlias",
                        "providerType", "oficioId", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, _p.dst, pr."canonicalName", pr.cuit, pr."matchNames", pr."paymentAlias",
       pr."providerType",
       (SELECT o2.id FROM "Oficio" o1
          JOIN "Oficio" o2 ON o2.name = o1.name AND o2."clientId" = _p.dst
         WHERE o1.id = pr."oficioId"),
       now(), now()
FROM "Provider" pr, _p WHERE pr."clientId" = _p.src
ON CONFLICT DO NOTHING;

-- ── Edificios (con su cuenta; sin carpeta de Rendiciones) ─────────────────
INSERT INTO "Consortium" (id, "clientId", "canonicalName", "rawName", cuit, "cutoffDay", "matchNames",
                          "bankId", "bankAlias", cbu, "accountNumber", branch, "accountType",
                          "accountHolder", "suterhKey", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, _p.dst, e."canonicalName", e."rawName", e.cuit, e."cutoffDay", e."matchNames",
       (SELECT b2.id FROM "Bank" b1
          JOIN "Bank" b2 ON b2.name = b1.name AND b2."clientId" = _p.dst
         WHERE b1.id = e."bankId"),
       e."bankAlias", e.cbu, e."accountNumber", e.branch, e."accountType",
       e."accountHolder", e."suterhKey", now(), now()
FROM _edif e, _p;

-- ── Tablas de correspondencia viejo → nuevo ───────────────────────────────
CREATE TEMP TABLE _mc ON COMMIT DROP AS
SELECT e.id AS old_id, c.id AS new_id
FROM _edif e JOIN _p ON true
JOIN "Consortium" c ON c."clientId" = _p.dst AND c."canonicalName" = e."canonicalName";

CREATE TEMP TABLE _mp ON COMMIT DROP AS
SELECT a.id AS old_id, b.id AS new_id
FROM "Provider" a JOIN _p ON a."clientId" = _p.src
JOIN "Provider" b ON b."clientId" = _p.dst AND b."canonicalName" = a."canonicalName";

CREATE TEMP TABLE _mr ON COMMIT DROP AS
SELECT a.id AS old_id, b.id AS new_id
FROM "Rubro" a JOIN _p ON a."clientId" = _p.src
JOIN "Rubro" b ON b."clientId" = _p.dst AND b.name = a.name;

CREATE TEMP TABLE _mk ON COMMIT DROP AS
SELECT a.id AS old_id, b.id AS new_id
FROM "Coeficiente" a JOIN _p ON a."clientId" = _p.src
JOIN "Coeficiente" b ON b."clientId" = _p.dst AND b.code = a.code;

-- ── Servicios (LspService) ────────────────────────────────────────────────
INSERT INTO "LspService" (id, "clientId", "consortiumId", "providerName", "providerId",
                          "clientNumber", description, "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, _p.dst, mc.new_id, l."providerName", mp.new_id,
       l."clientNumber", l.description, now(), now()
FROM "LspService" l
JOIN _mc mc ON mc.old_id = l."consortiumId"
LEFT JOIN _mp mp ON mp.old_id = l."providerId"
CROSS JOIN _p;

CREATE TEMP TABLE _ml ON COMMIT DROP AS
SELECT l.id AS old_id, n.id AS new_id
FROM "LspService" l
JOIN _mc mc ON mc.old_id = l."consortiumId"
JOIN "LspService" n ON n."consortiumId" = mc.new_id
                   AND n."providerName" = l."providerName"
                   AND n."clientNumber" = l."clientNumber";

-- ── Qué rubros / coeficientes / proveedores usa cada edificio ─────────────
INSERT INTO "ConsortiumRubro" (id, "consortiumId", "rubroId", "createdAt")
SELECT gen_random_uuid()::text, mc.new_id, mr.new_id, now()
FROM "ConsortiumRubro" x
JOIN _mc mc ON mc.old_id = x."consortiumId"
JOIN _mr mr ON mr.old_id = x."rubroId";

INSERT INTO "ConsortiumCoeficiente" (id, "consortiumId", "coeficienteId", "createdAt")
SELECT gen_random_uuid()::text, mc.new_id, mk.new_id, now()
FROM "ConsortiumCoeficiente" x
JOIN _mc mc ON mc.old_id = x."consortiumId"
JOIN _mk mk ON mk.old_id = x."coeficienteId";

INSERT INTO "ConsortiumProvider" (id, "consortiumId", "providerId", "createdAt")
SELECT gen_random_uuid()::text, mc.new_id, mp.new_id, now()
FROM "ConsortiumProvider" x
JOIN _mc mc ON mc.old_id = x."consortiumId"
JOIN _mp mp ON mp.old_id = x."providerId";

-- ── Gastos fijos ──────────────────────────────────────────────────────────
-- Chequeo: ningún gasto fijo puede perder su proveedor o su servicio en la copia.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
  FROM "FixedExpense" f
  JOIN _mc mc ON mc.old_id = f."consortiumId"
  LEFT JOIN _mp mp ON mp.old_id = f."providerId"
  LEFT JOIN _ml ml ON ml.old_id = f."lspServiceId"
  WHERE (f."providerId" IS NOT NULL AND mp.new_id IS NULL)
     OR (f."lspServiceId" IS NOT NULL AND ml.new_id IS NULL);
  IF n > 0 THEN RAISE EXCEPTION '% gastos fijos quedarían sin proveedor/servicio: no se copia nada', n; END IF;
END $$;

INSERT INTO "FixedExpense" (id, "clientId", "consortiumId", "providerId", "lspServiceId", description,
                            kind, "rubroId", "coeficienteId", active, "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, _p.dst, mc.new_id, mp.new_id, ml.new_id, f.description,
       f.kind, mr.new_id, mk.new_id, f.active, now(), now()
FROM "FixedExpense" f
JOIN _mc mc ON mc.old_id = f."consortiumId"
LEFT JOIN _mp mp ON mp.old_id = f."providerId"
LEFT JOIN _ml ml ON ml.old_id = f."lspServiceId"
LEFT JOIN _mr mr ON mr.old_id = f."rubroId"
LEFT JOIN _mk mk ON mk.old_id = f."coeficienteId"
CROSS JOIN _p;

-- ── Período activo (mismo mes que el de MorinigoAdm) ──────────────────────
INSERT INTO "Period" (id, "clientId", "consortiumId", year, month, status, "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, _p.dst, mc.new_id, pe.year, pe.month, 'ACTIVE', now(), now()
FROM "Period" pe
JOIN _mc mc ON mc.old_id = pe."consortiumId"
CROSS JOIN _p
WHERE pe.status = 'ACTIVE';

-- ── Verificación final: origen y copia tienen que coincidir ───────────────
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM _mc mc
  WHERE (SELECT count(*) FROM "FixedExpense" WHERE "consortiumId" = mc.old_id)
     <> (SELECT count(*) FROM "FixedExpense" WHERE "consortiumId" = mc.new_id)
     OR (SELECT count(*) FROM "LspService" WHERE "consortiumId" = mc.old_id)
     <> (SELECT count(*) FROM "LspService" WHERE "consortiumId" = mc.new_id)
     OR (SELECT count(*) FROM "ConsortiumRubro" WHERE "consortiumId" = mc.old_id)
     <> (SELECT count(*) FROM "ConsortiumRubro" WHERE "consortiumId" = mc.new_id)
     OR (SELECT count(*) FROM "ConsortiumCoeficiente" WHERE "consortiumId" = mc.old_id)
     <> (SELECT count(*) FROM "ConsortiumCoeficiente" WHERE "consortiumId" = mc.new_id)
     OR (SELECT count(*) FROM "Period" WHERE "consortiumId" = mc.new_id AND status = 'ACTIVE') <> 1;
  IF n > 0 THEN RAISE EXCEPTION '% edificios no coinciden con el original: no se copia nada', n; END IF;
END $$;

COMMIT;

-- Listo. Para ver el resultado, correr 03-verificar.sql (sólo lectura).
