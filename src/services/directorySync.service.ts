import { Prisma, type PrismaClient } from "@prisma/client";
import { formatCuit } from "@/lib/cuit";
import { buildBulkUpdate, type BulkColumn, type BulkRow } from "@/lib/bulkUpdate";
import {
  normalizeLspClientNumber,
  planCuitEntity,
  planKeyedEntity,
  type EntityOrphan,
  type EntityRename,
  type EntityUpdate,
} from "@/lib/directorySyncPlan";
import type { ProviderTypeValue } from "@/lib/providerType";
import type { DirectoryData } from "./googleSheets.service";

export type EntityReport = {
  created: number;
  updated: number;
  orphans: Array<{ id: string; name: string; invoices?: number }>;
};

export type DirectorySyncReport = {
  consortiums: EntityReport;
  providers: EntityReport;
  rubros: EntityReport;
  coeficientes: EntityReport;
  lspServices: EntityReport;
  oficios: EntityReport;
  /** Renombres detectados, pendientes de confirmación del usuario. */
  pendingRenames: Array<EntityRename & { entity: "consortium" | "provider"; invoices: number; periods: number }>;
  ambiguous: string[];
  warnings: string[];
};

const TX_OPTS = { maxWait: 10000, timeout: 120000 };

/**
 * Aplica los updates de una entidad en una sola query.
 *
 * Cada update trae el valor final de todas las columnas comparables (ver
 * `EntityUpdate`), así que la query escribe siempre el mismo juego de columnas y
 * ninguna fila puede quedar con un `null` por no haber estado en el diff.
 */
async function applyUpdates(
  tx: Prisma.TransactionClient,
  table: string,
  columns: BulkColumn[],
  updates: EntityUpdate[]
): Promise<void> {
  if (updates.length === 0) return;

  const rows: BulkRow[] = updates.map((u) => ({
    id: u.id,
    values: columns.map((c) => u.values[c.name] ?? null),
  }));

  const sql = buildBulkUpdate({ table, columns, rows });
  if (!sql) return;
  await tx.$executeRaw(sql);
}

export async function syncDirectory(
  prisma: PrismaClient,
  clientId: string,
  directory: DirectoryData
): Promise<DirectorySyncReport> {
  const warnings = [...directory.warnings];
  const ambiguous: string[] = [];
  const pendingRenames: DirectorySyncReport["pendingRenames"] = [];

  // ---- Consorcios ----
  const existingConsortiums = await prisma.consortium.findMany({
    where: { clientId },
    select: { id: true, canonicalName: true, cuit: true, matchNames: true },
  });

  const consortiumPlan = planCuitEntity({
    sheetRows: directory.consortiums,
    existing: existingConsortiums,
    compareFields: ["cuit", "matchNames"],
  });
  ambiguous.push(...consortiumPlan.ambiguous);

  await prisma.$transaction(async (tx) => {
    if (consortiumPlan.creates.length > 0) {
      await tx.consortium.createMany({
        data: consortiumPlan.creates.map((c) => ({
          clientId,
          canonicalName: c.canonicalName,
          rawName: c.canonicalName,
          cuit: formatCuit(c.cuit) ?? c.cuit,
          matchNames: c.matchNames,
        })),
      });
    }
    await applyUpdates(
      tx,
      "Consortium",
      [
        { name: "cuit", cast: "text" },
        { name: "matchNames", cast: "text" },
      ],
      consortiumPlan.updates
    );
  }, TX_OPTS);

  // ---- Oficios ----
  // Van ANTES que los proveedores: la columna OFICIO de `_Proveedores` trae un
  // nombre que hay que resolver a un id, y puede referirse a uno recién creado.
  const existingOficios = await prisma.oficio.findMany({
    where: { clientId },
    select: { id: true, name: true, description: true },
  });
  const oficioPlan = planKeyedEntity({
    sheetRows: directory.oficios,
    existing: existingOficios,
    keyOf: (o) => o.name,
    compareFields: ["description"],
    nameOf: (o) => o.name,
  });

  await prisma.$transaction(async (tx) => {
    if (oficioPlan.creates.length > 0) {
      await tx.oficio.createMany({
        data: oficioPlan.creates.map((o) => ({ clientId, name: o.name, description: o.description })),
      });
    }
    await applyUpdates(tx, "Oficio", [{ name: "description", cast: "text" }], oficioPlan.updates);
  }, TX_OPTS);

  const oficiosNow = await prisma.oficio.findMany({
    where: { clientId },
    select: { id: true, name: true },
  });
  const oficioIdByName = new Map(oficiosNow.map((o) => [o.name, o.id]));

  // ---- Proveedores ----
  const existingProviders = await prisma.provider.findMany({
    where: { clientId },
    select: {
      id: true,
      canonicalName: true,
      cuit: true,
      matchNames: true,
      paymentAlias: true,
      providerType: true,
      oficioId: true,
    },
  });

  // La columna OFICIO trae un nombre; acá se convierte en el id que va a la base.
  // Si no está en el catálogo, el proveedor se carga igual y se avisa: un dato de
  // catalogación no puede impedir que se cargue un proveedor.
  const providerSheetRows = directory.providers.map((p) => {
    const oficioId = p.oficioName ? oficioIdByName.get(p.oficioName) ?? null : null;
    if (p.oficioName && !oficioId) {
      warnings.push(
        `El proveedor "${p.canonicalName}" declara el oficio "${p.oficioName}", que no está en la hoja _Oficios.`
      );
    }
    return {
      canonicalName: p.canonicalName,
      cuit: p.cuit,
      matchNames: p.matchNames,
      paymentAlias: p.paymentAlias,
      providerType: p.providerType,
      oficioId,
    };
  });

  const providerPlan = planCuitEntity({
    sheetRows: providerSheetRows,
    existing: existingProviders,
    compareFields: ["cuit", "matchNames", "paymentAlias", "providerType", "oficioId"],
  });
  ambiguous.push(...providerPlan.ambiguous);

  await prisma.$transaction(async (tx) => {
    if (providerPlan.creates.length > 0) {
      await tx.provider.createMany({
        data: providerPlan.creates.map((p) => ({
          clientId,
          canonicalName: p.canonicalName,
          cuit: formatCuit(p.cuit) ?? p.cuit,
          matchNames: p.matchNames,
          paymentAlias: p.paymentAlias ?? null,
          providerType: (p.providerType ?? "PROVEEDOR") as ProviderTypeValue,
          oficioId: p.oficioId ?? null,
        })),
      });
    }
    await applyUpdates(
      tx,
      "Provider",
      [
        { name: "cuit", cast: "text" },
        { name: "matchNames", cast: "text" },
        { name: "paymentAlias", cast: "text" },
        { name: "providerType", cast: '"ProviderType"' },
        { name: "oficioId", cast: "text" },
      ],
      providerPlan.updates
    );
  }, TX_OPTS);

  // ---- Rubros ----
  const existingRubros = await prisma.rubro.findMany({
    where: { clientId },
    select: { id: true, name: true, description: true },
  });
  const rubroPlan = planKeyedEntity({
    sheetRows: directory.rubros,
    existing: existingRubros,
    keyOf: (r) => r.name,
    compareFields: ["description"],
    nameOf: (r) => r.name,
  });

  await prisma.$transaction(async (tx) => {
    if (rubroPlan.creates.length > 0) {
      await tx.rubro.createMany({
        data: rubroPlan.creates.map((r) => ({ clientId, name: r.name, description: r.description })),
      });
    }
    await applyUpdates(tx, "Rubro", [{ name: "description", cast: "text" }], rubroPlan.updates);
  }, TX_OPTS);

  // ---- Coeficientes ----
  const existingCoeficientes = await prisma.coeficiente.findMany({
    where: { clientId },
    select: { id: true, code: true, name: true },
  });
  const coeficientePlan = planKeyedEntity({
    sheetRows: directory.coeficientes,
    existing: existingCoeficientes,
    keyOf: (c) => c.code,
    compareFields: ["name"],
    nameOf: (c) => `${c.code} — ${c.name}`,
  });

  await prisma.$transaction(async (tx) => {
    if (coeficientePlan.creates.length > 0) {
      await tx.coeficiente.createMany({
        data: coeficientePlan.creates.map((c) => ({ clientId, code: c.code, name: c.name })),
      });
    }
    await applyUpdates(tx, "Coeficiente", [{ name: "name", cast: "text" }], coeficientePlan.updates);
  }, TX_OPTS);

  // ---- LspServices ----
  // Se resuelven DESPUÉS de los consorcios porque necesitan el id de los recién
  // creados. Los que ya existen conservan su id: eso es lo que impide que las
  // boletas pierdan `lspServiceId` (antes se borraban y recreaban en cada sync).
  const consortiumsNow = await prisma.consortium.findMany({
    where: { clientId },
    select: { id: true, canonicalName: true },
  });
  const consortiumIdByName = new Map(consortiumsNow.map((c) => [c.canonicalName, c.id]));

  const providersNow = await prisma.provider.findMany({
    where: { clientId },
    select: { id: true, canonicalName: true, providerType: true },
  });
  const providerByName = new Map(providersNow.map((p) => [p.canonicalName.toUpperCase(), p]));

  const lspSheetRows: Array<{
    consortiumId: string;
    providerName: string;
    clientNumber: string;
    description: string | null;
    providerId: string | null;
  }> = [];

  for (const ls of directory.lspServices) {
    const consortiumId = consortiumIdByName.get(ls.consortiumName);
    if (!consortiumId) {
      warnings.push(
        `Servicio ignorado: el consorcio "${ls.consortiumName}" no está en la base (proveedor ${ls.provider}, nro ${ls.clientNumber})`
      );
      continue;
    }
    const provider = providerByName.get(ls.provider.toUpperCase()) ?? null;

    // El tipo no condiciona el vínculo con la boleta (eso lo resuelve el pipeline
    // por número de cliente), así que esto avisa y sigue: bloquear dejaría
    // servicios sin cargar por un dato de catalogación.
    if (provider && provider.providerType !== "SERVICIO") {
      warnings.push(
        `El proveedor "${ls.provider}" tiene servicios cargados pero no está marcado como SERVICIO en el ALTA (columna TIPO).`
      );
    }

    lspSheetRows.push({
      consortiumId,
      providerName: ls.provider,
      clientNumber: normalizeLspClientNumber(ls.clientNumber),
      description: ls.description,
      providerId: provider?.id ?? null,
    });
  }

  const existingLsp = await prisma.lspService.findMany({
    where: { clientId },
    select: {
      id: true,
      consortiumId: true,
      providerName: true,
      clientNumber: true,
      description: true,
      providerId: true,
    },
  });

  const lspKey = (r: { consortiumId: string; providerName: string; clientNumber: string }) =>
    `${r.consortiumId}|${r.providerName}|${r.clientNumber}`;

  const lspPlan = planKeyedEntity({
    sheetRows: lspSheetRows,
    existing: existingLsp,
    keyOf: lspKey,
    compareFields: ["description", "providerId"],
    nameOf: (l) => `${l.providerName} ${l.clientNumber}`,
  });

  await prisma.$transaction(async (tx) => {
    if (lspPlan.creates.length > 0) {
      await tx.lspService.createMany({
        data: lspPlan.creates.map((l) => ({
          clientId,
          consortiumId: l.consortiumId,
          providerName: l.providerName,
          providerId: l.providerId,
          clientNumber: l.clientNumber,
          description: l.description,
        })),
      });
    }
    await applyUpdates(
      tx,
      "LspService",
      [
        { name: "description", cast: "text" },
        { name: "providerId", cast: "text" },
      ],
      lspPlan.updates
    );
  }, TX_OPTS);

  // ---- Conteos para el reporte (una query agrupada, no una por registro) ----
  const orphanConsortiumIds = consortiumPlan.orphans.map((o) => o.id);
  const renameConsortiumIds = consortiumPlan.renames.map((r) => r.id);

  const invoiceCounts = await prisma.invoice.groupBy({
    by: ["consortiumId"],
    where: { clientId, consortiumId: { in: [...orphanConsortiumIds, ...renameConsortiumIds] } },
    _count: { _all: true },
  });
  const invoicesByConsortium = new Map(invoiceCounts.map((c) => [c.consortiumId, c._count._all]));

  const periodCounts = await prisma.period.groupBy({
    by: ["consortiumId"],
    where: { consortiumId: { in: renameConsortiumIds } },
    _count: { _all: true },
  });
  const periodsByConsortium = new Map(periodCounts.map((p) => [p.consortiumId, p._count._all]));

  const providerInvoiceCounts = await prisma.invoice.groupBy({
    by: ["providerId"],
    where: { clientId, providerId: { in: providerPlan.orphans.map((o) => o.id) } },
    _count: { _all: true },
  });
  const invoicesByProvider = new Map(providerInvoiceCounts.map((c) => [c.providerId, c._count._all]));

  for (const r of consortiumPlan.renames) {
    pendingRenames.push({
      ...r,
      entity: "consortium",
      invoices: invoicesByConsortium.get(r.id) ?? 0,
      periods: periodsByConsortium.get(r.id) ?? 0,
    });
  }
  for (const r of providerPlan.renames) {
    pendingRenames.push({ ...r, entity: "provider", invoices: 0, periods: 0 });
  }

  const withCounts = (orphans: EntityOrphan[], counts: Map<string | null, number>) =>
    orphans.map((o) => ({ ...o, invoices: counts.get(o.id) ?? 0 }));

  return {
    consortiums: {
      created: consortiumPlan.creates.length,
      updated: consortiumPlan.updates.length,
      orphans: withCounts(consortiumPlan.orphans, invoicesByConsortium),
    },
    providers: {
      created: providerPlan.creates.length,
      updated: providerPlan.updates.length,
      orphans: withCounts(providerPlan.orphans, invoicesByProvider),
    },
    rubros: {
      created: rubroPlan.creates.length,
      updated: rubroPlan.updates.length,
      orphans: rubroPlan.orphans,
    },
    coeficientes: {
      created: coeficientePlan.creates.length,
      updated: coeficientePlan.updates.length,
      orphans: coeficientePlan.orphans,
    },
    lspServices: {
      created: lspPlan.creates.length,
      updated: lspPlan.updates.length,
      orphans: lspPlan.orphans,
    },
    oficios: {
      created: oficioPlan.creates.length,
      updated: oficioPlan.updates.length,
      orphans: oficioPlan.orphans,
    },
    pendingRenames,
    ambiguous,
    warnings,
  };
}

export type ApplyRenamesResult = { applied: number; skipped: Array<{ id: string; reason: string }> };

/**
 * Aplica los renombres que el usuario confirmó en la UI. Recibe la lista exacta
 * — no vuelve a deducir nada de la hoja — así que es idempotente y no puede
 * tocar nada que el usuario no haya visto en pantalla.
 *
 * Además del nombre, suma el nombre viejo a `matchNames` para que las boletas que
 * traigan impreso el anterior sigan matcheando.
 */
export async function applyRenames(
  prisma: PrismaClient,
  clientId: string,
  renames: Array<{ entity: "consortium" | "provider"; id: string; to: string }>
): Promise<ApplyRenamesResult> {
  let applied = 0;
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const rename of renames) {
    if (rename.entity === "consortium") {
      const current = await prisma.consortium.findFirst({
        where: { id: rename.id, clientId },
        select: { id: true, canonicalName: true, matchNames: true },
      });
      if (!current) {
        skipped.push({ id: rename.id, reason: "no encontrado" });
        continue;
      }
      if (current.canonicalName === rename.to) {
        skipped.push({ id: rename.id, reason: "ya tenía ese nombre" });
        continue;
      }

      const clash = await prisma.consortium.findFirst({
        where: { clientId, canonicalName: rename.to },
        select: { id: true },
      });
      if (clash) {
        skipped.push({ id: rename.id, reason: "el nombre destino ya existe" });
        continue;
      }

      await prisma.consortium.update({
        where: { id: current.id },
        data: {
          canonicalName: rename.to,
          rawName: rename.to,
          matchNames: appendMatchName(current.matchNames, current.canonicalName),
        },
      });
      applied++;
      continue;
    }

    const current = await prisma.provider.findFirst({
      where: { id: rename.id, clientId },
      select: { id: true, canonicalName: true, matchNames: true },
    });
    if (!current) {
      skipped.push({ id: rename.id, reason: "no encontrado" });
      continue;
    }
    if (current.canonicalName === rename.to) {
      skipped.push({ id: rename.id, reason: "ya tenía ese nombre" });
      continue;
    }

    const clash = await prisma.provider.findFirst({
      where: { clientId, canonicalName: rename.to },
      select: { id: true },
    });
    if (clash) {
      skipped.push({ id: rename.id, reason: "el nombre destino ya existe" });
      continue;
    }

    await prisma.provider.update({
      where: { id: current.id },
      data: {
        canonicalName: rename.to,
        matchNames: appendMatchName(current.matchNames, current.canonicalName),
      },
    });
    applied++;
  }

  return { applied, skipped };
}

/** Suma un alias a `matchNames` sin duplicarlo. Separador `|`, como el resto del sistema. */
export function appendMatchName(current: string | null, name: string): string {
  const parts = (current ?? "").split("|").map((p) => p.trim()).filter(Boolean);
  if (parts.some((p) => p.toUpperCase() === name.toUpperCase())) return parts.join(" | ");
  return [...parts, name].join(" | ");
}
