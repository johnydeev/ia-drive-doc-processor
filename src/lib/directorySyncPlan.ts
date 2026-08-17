import { cuitDigits, formatCuit } from "./cuit";

/**
 * Decisión pura del sync de directorio: qué crear, qué actualizar, qué renombrar
 * y qué sobra. Sin Prisma y sin red, para poder probar con objetos en memoria.
 *
 * Principio: el ALTA manda sobre el directorio, no sobre los datos operativos.
 * Este módulo NO produce borrados — lo que está en la base y no en la hoja se
 * reporta en `orphans` y se queda. El endpoint viejo sí borraba, y como todas las
 * relaciones hijas son `Cascade`, se llevaba períodos, gastos fijos y obligaciones
 * en silencio (ver docs/superpowers/specs/2026-08-17-sync-directory-*).
 */

/** Fila de la hoja para una entidad con CUIT (consorcio o proveedor). */
export type CuitSheetRow = {
  canonicalName: string;
  cuit: string | null;
  matchNames: string | null;
  paymentAlias?: string | null;
  providerType?: string;
};

/** Fila de la base para esas mismas entidades. */
export type CuitExistingRow = CuitSheetRow & { id: string };

/**
 * Un update lleva el valor final de TODAS las columnas comparables, no sólo el de
 * las que cambiaron: el servicio las escribe juntas en un único
 * `UPDATE ... FROM (VALUES ...)`, y una columna que faltara se escribiría como null.
 */
export type EntityUpdate = { id: string; values: Record<string, unknown> };
export type EntityRename = { id: string; from: string; to: string; cuit: string };
export type EntityOrphan = { id: string; name: string };

export type CuitEntityPlan<TRow> = {
  creates: TRow[];
  updates: EntityUpdate[];
  renames: EntityRename[];
  orphans: EntityOrphan[];
  /** Nombres de la hoja cuyo CUIT matchea a más de un registro: no se tocan. */
  ambiguous: string[];
};

/**
 * El CUIT se normaliza al formato canónico antes de comparar y de guardar, igual
 * que hacía el endpoint viejo: las planillas lo traen sin guiones y la base con.
 */
function normalizedValue(field: string, value: unknown): unknown {
  if (field === "cuit") return formatCuit(value as string | null) ?? (value ?? null);
  return value ?? null;
}

export function planCuitEntity<TRow extends CuitSheetRow>({
  sheetRows,
  existing,
  compareFields,
}: {
  sheetRows: TRow[];
  existing: CuitExistingRow[];
  compareFields: readonly string[];
}): CuitEntityPlan<TRow> {
  const byName = new Map(existing.map((e) => [e.canonicalName, e]));
  const namesInSheet = new Set(sheetRows.map((r) => r.canonicalName));

  const byCuit = new Map<string, CuitExistingRow[]>();
  for (const e of existing) {
    const digits = cuitDigits(e.cuit);
    if (!digits) continue;
    const list = byCuit.get(digits) ?? [];
    list.push(e);
    byCuit.set(digits, list);
  }

  const creates: TRow[] = [];
  const updates: EntityUpdate[] = [];
  const renames: EntityRename[] = [];
  const ambiguous: string[] = [];
  const renamedIds = new Set<string>();

  for (const row of sheetRows) {
    const hit = byName.get(row.canonicalName);

    if (hit) {
      const values: Record<string, unknown> = {};
      let dirty = false;
      for (const field of compareFields) {
        const next = normalizedValue(field, (row as Record<string, unknown>)[field]);
        const current = normalizedValue(field, (hit as Record<string, unknown>)[field]);
        values[field] = next;
        if (next !== current) dirty = true;
      }
      if (dirty) updates.push({ id: hit.id, values });
      continue;
    }

    // Candidato a renombre: las tres guardas del spec. El CUIT tiene que existir,
    // apuntar a exactamente un registro, y ese registro no puede estar ya
    // representado por otra fila de la hoja (si lo está, esto es un alta).
    const digits = cuitDigits(row.cuit);
    const candidates = digits
      ? (byCuit.get(digits) ?? []).filter((e) => !namesInSheet.has(e.canonicalName))
      : [];

    if (candidates.length === 1) {
      const target = candidates[0];
      renames.push({
        id: target.id,
        from: target.canonicalName,
        to: row.canonicalName,
        cuit: formatCuit(row.cuit) ?? (row.cuit as string),
      });
      renamedIds.add(target.id);
      continue;
    }

    if (candidates.length > 1) {
      ambiguous.push(row.canonicalName);
      continue;
    }

    creates.push(row);
  }

  const orphans = existing
    .filter((e) => !namesInSheet.has(e.canonicalName) && !renamedIds.has(e.id))
    .map((e) => ({ id: e.id, name: e.canonicalName }));

  return { creates, updates, renames, orphans, ambiguous };
}

export type KeyedEntityPlan<TRow> = {
  creates: TRow[];
  updates: EntityUpdate[];
  orphans: EntityOrphan[];
};

/**
 * Plan para las entidades sin CUIT (rubros, coeficientes, servicios LSP), que se
 * identifican por su clave natural. Reemplaza al viejo `deleteMany` + `createMany`:
 * el registro que ya existe se conserva con su `id`, y por lo tanto conserva
 * también todo lo que lo apunta (boletas, gastos fijos).
 *
 * `nameOf` es sólo para el reporte: qué mostrarle al usuario como sobrante.
 */
export function planKeyedEntity<TRow extends object, TExisting extends TRow & { id: string }>({
  sheetRows,
  existing,
  keyOf,
  compareFields,
  nameOf,
}: {
  sheetRows: TRow[];
  existing: TExisting[];
  keyOf: (row: TRow) => string;
  compareFields: readonly string[];
  nameOf?: (row: TExisting) => string;
}): KeyedEntityPlan<TRow> {
  const byKey = new Map(existing.map((e) => [keyOf(e), e]));
  const keysInSheet = new Set(sheetRows.map(keyOf));

  const creates: TRow[] = [];
  const updates: EntityUpdate[] = [];

  for (const row of sheetRows) {
    const hit = byKey.get(keyOf(row));
    if (!hit) {
      creates.push(row);
      continue;
    }
    const values: Record<string, unknown> = {};
    let dirty = false;
    for (const field of compareFields) {
      const next = (row as Record<string, unknown>)[field] ?? null;
      const current = (hit as Record<string, unknown>)[field] ?? null;
      values[field] = next;
      if (next !== current) dirty = true;
    }
    if (dirty) updates.push({ id: hit.id, values });
  }

  const orphans = existing
    .filter((e) => !keysInSheet.has(keyOf(e)))
    .map((e) => ({ id: e.id, name: nameOf ? nameOf(e) : keyOf(e) }));

  return { creates, updates, orphans };
}

/**
 * Normalización del número de cliente de un LspService. Se preserva literal del
 * endpoint viejo porque forma parte de la clave natural: cambiarla convertiría
 * todos los servicios existentes en registros nuevos.
 */
export function normalizeLspClientNumber(raw: string): string {
  return raw.replace(/\s+/g, "").replace(/^0+/, "") || raw;
}
