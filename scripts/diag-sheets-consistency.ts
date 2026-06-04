/**
 * scripts/diag-sheets-consistency.ts
 * DIAGNÓSTICO READ-ONLY: compara la hoja de Google Sheets contra la DB
 * para detectar inconsistencias en la inserción de boletas.
 *
 * No modifica nada. Solo lee.
 *
 * Uso:
 *   npx tsx scripts/diag-sheets-consistency.ts            (default: MorinigoAdm)
 *   npx tsx scripts/diag-sheets-consistency.ts --name=OtroCliente
 */

import "@/lib/loadEnv";
import { google } from "googleapis";
import { getPrismaClient } from "@/lib/prisma";
import { resolveGoogleConfig, resolveSheetName } from "@/lib/clientProcessingConfig";
import type { ProcessingClient, ClientDriveFolders, ClientGoogleConfig } from "@/types/client.types";

async function main() {
  const prisma = getPrismaClient();
  const args = Object.fromEntries(
    process.argv.slice(2).filter(a => a.startsWith("--")).map(a => {
      const [k, v] = a.slice(2).split("="); return [k, v ?? "true"];
    })
  );
  const name = args.name ?? "MorinigoAdm";

  const client = await prisma.client.findFirst({
    where: { name },
    select: { id: true, name: true, driveFoldersJson: true, googleConfigJson: true, extractionConfigJson: true },
  });
  if (!client) throw new Error(`Cliente no encontrado: ${name}`);

  const pc: ProcessingClient = {
    id: client.id, name: client.name ?? "", isActive: true, batchSize: 10, intervalMinutes: 60,
    driveFoldersJson: (client.driveFoldersJson as ClientDriveFolders | null) ?? null,
    googleConfigJson: (client.googleConfigJson as ClientGoogleConfig | null) ?? null,
    extractionConfigJson: (client.extractionConfigJson as Record<string, unknown> | null) ?? null,
  };
  const gc = resolveGoogleConfig(pc);
  if (!gc) throw new Error("Sin Google config resoluble");
  const sheetName = resolveSheetName(pc);

  const auth = new google.auth.JWT({
    email: gc.clientEmail,
    key: gc.privateKey.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: gc.sheetsId,
    range: `${sheetName}!A:U`,
  });
  const rows = res.data.values ?? [];

  const dataRows = rows.slice(1); // sin header
  let nonEmpty = 0;
  let lastNonEmptyIdx = -1;
  dataRows.forEach((r, i) => {
    const has = (r ?? []).some(c => String(c ?? "").trim().length > 0);
    if (has) { nonEmpty++; lastNonEmptyIdx = i; }
  });
  let emptyInside = 0;
  dataRows.slice(0, lastNonEmptyIdx + 1).forEach(r => {
    const has = (r ?? []).some(c => String(c ?? "").trim().length > 0);
    if (!has) emptyInside++;
  });

  // RIVADAVIA / boleta puntual: columna A (boletaNumber) = índice 0
  const target = args.boleta ?? "0002-00330905";
  const foundIdx = dataRows.findIndex(r => String(r?.[0] ?? "").trim() === target);

  // Duplicados de boletaNumber en la hoja (señal de pisado/reinsert)
  const counts = new Map<string, number>();
  dataRows.forEach(r => {
    const b = String(r?.[0] ?? "").trim();
    if (b) counts.set(b, (counts.get(b) ?? 0) + 1);
  });
  const dups = [...counts.entries()].filter(([, n]) => n > 1);

  const dbCount = await prisma.invoice.count({ where: { clientId: client.id } });

  // ── Análisis fino de duplicados ──────────────────────────────────────────
  // Columnas (A:U → A=0): provider=B(1), consortium=C(2), providerTaxId=D(3),
  // amount=H(7), isDuplicate=L(11)
  const cell = (r: string[] | undefined, i: number) => String(r?.[i] ?? "").trim();
  let markedDuplicate = 0;
  dataRows.forEach(r => {
    const dup = cell(r, 11).toUpperCase();
    if (dup === "YES" || dup === "SI" || dup === "SÍ" || dup === "TRUE") markedDuplicate++;
  });

  console.log("\n=== DETALLE DE DUPLICADOS (mismo boletaNumber) ===");
  console.log("Filas marcadas isDuplicate (col L = YES/SI):", markedDuplicate);
  console.log("--------------------------------------------------");
  for (const [bn] of dups) {
    const matches = dataRows
      .map((r, i) => ({ r, row: i + 2 }))
      .filter(({ r }) => cell(r, 0) === bn);
    console.log(`\nboletaNumber="${bn}" → ${matches.length} filas:`);
    for (const { r, row } of matches) {
      console.log(`  fila ${row}: prov="${cell(r,1)}" cons="${cell(r,2)}" cuit="${cell(r,3)}" monto="${cell(r,7)}" dup="${cell(r,11)}"`);
    }
  }

  console.log("\n=== DIAGNÓSTICO SHEETS vs DB ===");
  console.log("Cliente:", client.name, "| hoja:", sheetName);
  console.log("Spreadsheet ID:", gc.sheetsId);
  console.log("--------------------------------------------------");
  console.log("values.get length (lo que ve insertRow):", rows.length, "(incluye header)");
  console.log("Filas de datos en el array:           ", dataRows.length);
  console.log("Filas de datos NO vacías:             ", nonEmpty);
  console.log("Filas vacías ENTRE los datos (gaps):  ", emptyInside);
  console.log("Última fila con datos (1-based):      ", lastNonEmptyIdx >= 0 ? lastNonEmptyIdx + 2 : "—");
  console.log("--------------------------------------------------");
  console.log("Invoices en DB:                       ", dbCount);
  console.log("Diferencia (DB - Sheets no vacías):   ", dbCount - nonEmpty);
  console.log("--------------------------------------------------");
  console.log(`Boleta "${target}":`, foundIdx >= 0 ? `ENCONTRADA en fila ${foundIdx + 2}` : "❌ NO ESTÁ EN LA HOJA");
  console.log("boletaNumbers duplicados en hoja:     ", dups.length);
  if (dups.length) console.log("  ejemplos:", dups.slice(0, 10));
  console.log("==================================================\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
