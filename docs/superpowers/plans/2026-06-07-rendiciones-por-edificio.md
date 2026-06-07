# Rendiciones por edificio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Organizar automáticamente cada boleta y recibo en `statements/[Edificio]/[Período]/` en Drive, con la carpeta del edificio compartida públicamente (para QR), tanto en el pipeline como en la carga manual.

**Architecture:** El destino "Escaneados" de las boletas OK se reemplaza por una estructura `Rendiciones/[Edificio]/[Período]`. La carpeta raíz (`statements`) la configura el owner; la app crea/comparte las subcarpetas. Validaciones preventivas en el scheduler (carpetas + período) evitan gastar tokens. Recibos van junto a su boleta.

**Tech Stack:** Next.js + TypeScript + Prisma (PostgreSQL/Supabase) + googleapis (Drive/Sheets).

**Spec de referencia:** `docs/superpowers/specs/2026-06-05-rendiciones-por-edificio-design.md` — leerlo antes de empezar. Este plan asume sus decisiones.

**Convenciones del proyecto (de CLAUDE.md):**
- No hay suite de tests formal → verificación por `npx tsc --noEmit -p tsconfig.json` + script `tsx` para funciones puras + prueba funcional. Seguir ese patrón.
- PowerShell: comandos por separado (sin `&&`).
- Migraciones: Claude crea la carpeta + `migration.sql`; **el owner las ejecuta** (`prisma migrate deploy` + `prisma generate`). Parar los 3 procesos antes (DLL bloqueado en Windows).
- Commits: en español, estilo `feat:` / `fix:`.

---

## File Structure

| Archivo | Responsabilidad | Acción |
|---|---|---|
| `prisma/schema.prisma` | `Consortium.statementsFolderId` + `statementsFolderUrl` | Modificar |
| `prisma/migrations/<ts>_add_consortium_statements_folder/migration.sql` | SQL de la migración | Crear |
| `src/types/client.types.ts` | `ClientDriveFolders.statements` | Modificar |
| `src/lib/clientProcessingConfig.ts` | `ResolvedFolders.statements`, `resolveFolders`, `validateClientProcessingConfig` | Modificar |
| `src/lib/statementsNaming.ts` | Helpers puros de naming (boleta/recibo/período + sanitizar) | Crear |
| `src/services/googleDrive.service.ts` | `renameFile`, `shareFolderPublic` | Modificar |
| `src/services/statementsFolders.service.ts` | `resolveStatementsFolders` (orquestador + cache) | Crear |
| `src/jobs/processPendingDocuments.job.ts` | Integrar destino statements + período→Revisión | Modificar |
| `src/jobs/processPendingDocuments.job.ts` (config interface) | `driveStatementsFolderId` en `ProcessJobConfig` | Modificar |
| `src/jobs/runProcessingCycle.ts` + `src/jobs/jobWorkerMain.ts` | Propagar `driveStatementsFolderId` | Modificar |
| `src/jobs/scheduler.ts` | Validación preventiva (carpetas + período) — la "llave" | Modificar |
| `src/app/api/client/consortiums/[id]/invoices/route.ts` | Carga manual → statements | Modificar |
| `src/app/api/client/consortiums/[id]/invoices/[invoiceId]/receipt/route.ts` | Recibo → statements | Modificar |
| `src/app/api/client/consortiums/[id]/invoices/[invoiceId]/route.ts` | Delete: mover desde parent real → failed | Modificar (verificar) |
| `src/app/admin/consortiums/page.tsx` | Mostrar `statementsFolderUrl` + Copiar | Modificar |

---

## Task 0: Migración de schema (la ejecuta el OWNER)

**Files:**
- Modify: `prisma/schema.prisma` (modelo `Consortium`)
- Create: `prisma/migrations/20260607000100_add_consortium_statements_folder/migration.sql`

- [ ] **Step 1: Agregar campos al modelo `Consortium` en `schema.prisma`**

Buscar el modelo `Consortium` y agregar, junto a los otros campos String opcionales:

```prisma
  statementsFolderId  String?
  statementsFolderUrl String?
```

- [ ] **Step 2: Crear el archivo de migración**

`prisma/migrations/20260607000100_add_consortium_statements_folder/migration.sql`:

```sql
ALTER TABLE "Consortium" ADD COLUMN "statementsFolderId" TEXT;
ALTER TABLE "Consortium" ADD COLUMN "statementsFolderUrl" TEXT;
```

- [ ] **Step 3: AVISAR al owner (no ejecutar)**

Dejar nota: "Migración pendiente `20260607000100_add_consortium_statements_folder`. Ejecutar: parar procesos → `npx prisma migrate deploy` → `npx prisma generate`."

> No correr `prisma migrate deploy` ni `prisma generate` — los hace el owner. El resto del plan asume que el cliente Prisma ya tiene estos campos tras el deploy. Para typecheck local, el owner debe haber corrido `prisma generate` antes de continuar con las tareas que usan estos campos (Task 4 en adelante).

---

## Task 1: Config de carpeta `statements`

**Files:**
- Modify: `src/types/client.types.ts`
- Modify: `src/lib/clientProcessingConfig.ts`

- [ ] **Step 1: Agregar `statements` a `ClientDriveFolders`**

En `src/types/client.types.ts`, dentro de `interface ClientDriveFolders`, junto a `duplicates`:

```ts
  /**
   * Carpeta raíz "Rendiciones" (pública): dentro la app crea [Edificio]/[Período].
   * La crea el owner; su ID se configura acá. Solo las subcarpetas de edificio
   * se comparten públicas (la raíz queda privada).
   */
  statements?: string | null;
```

- [ ] **Step 2: Agregar `statements` a `ResolvedFolders` y `resolveFolders`**

En `src/lib/clientProcessingConfig.ts`, en `interface ResolvedFolders` agregar `statements: string | null;` y en `resolveFolders` el return:

```ts
    statements: f?.statements?.trim() || null,
```

- [ ] **Step 3: Validar `statements` en `validateClientProcessingConfig`**

En la misma función, después de la validación de `scanned`, agregar:

```ts
  if (!folders.statements) {
    throw new Error("Missing required client config: driveFoldersJson.statements (carpeta Rendiciones)");
  }
```

> Esto hace que el scheduler (que llama a `validateClientProcessingConfig` por cliente) saltee el cliente con aviso si falta `statements` — parte de la "llave" (Task 7).

- [ ] **Step 4: Verificar typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sin errores.

- [ ] **Step 5: Commit**

```bash
git add src/types/client.types.ts src/lib/clientProcessingConfig.ts
git commit -m "feat: agregar carpeta statements (Rendiciones) a la config de cliente"
```

---

## Task 2: Helpers de naming (funciones puras + verificación)

**Files:**
- Create: `src/lib/statementsNaming.ts`
- Create: `scripts/test-statements-naming.ts` (verificación, patrón del proyecto)

- [ ] **Step 1: Crear `src/lib/statementsNaming.ts`**

```ts
const MONTHS_ES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

/** Quita caracteres inválidos para nombres de archivo/carpeta de Drive. */
export function sanitizeName(value: string): string {
  return (value ?? "")
    .replace(/[/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "2026-06 Junio" — ordena cronológico y es legible. */
export function buildStatementPeriodFolderName(month: number, year: number): string {
  const mm = String(month).padStart(2, "0");
  return `${year}-${mm} ${MONTHS_ES[month - 1] ?? ""}`.trim();
}

function pTag(month: number, year: number): string {
  return `P${String(month).padStart(2, "0")}-${year}`;
}

function fmtDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getFullYear()}`;
}

/** Nombre de boleta. Sin N°, usa "SN " + 6 chars del hash para unicidad. */
export function buildInvoiceFileName(input: {
  provider: string | null;
  consortium: string | null;
  month: number;
  year: number;
  boletaNumber: string | null;
  documentHash: string;
}): string {
  const prov = sanitizeName(input.provider ?? "SIN PROVEEDOR");
  const cons = sanitizeName(input.consortium ?? "SIN CONSORCIO");
  const num = input.boletaNumber?.trim()
    ? sanitizeName(input.boletaNumber)
    : `SN ${input.documentHash.slice(0, 6)}`;
  return `${prov} - ${cons} - ${pTag(input.month, input.year)} - ${num}.pdf`;
}

/** Nombre de recibo según tipo de pago. */
export function buildReceiptFileName(input: {
  provider: string | null;
  consortium: string | null;
  month: number;
  year: number;
  boletaNumber: string | null;
  documentHash: string;
  paymentDate: Date;
  amount: number;
  installmentNumber?: number | null;
  totalInstallments?: number | null;
  saldaTotal: boolean; // true si el pago salda el total de la boleta
}): string {
  const prov = sanitizeName(input.provider ?? "SIN PROVEEDOR");
  const cons = sanitizeName(input.consortium ?? "SIN CONSORCIO");
  const num = input.boletaNumber?.trim()
    ? sanitizeName(input.boletaNumber)
    : `SN ${input.documentHash.slice(0, 6)}`;
  const base = `${prov} - ${cons} - ${pTag(input.month, input.year)} - ${num}`;
  const fecha = fmtDate(input.paymentDate);

  if ((input.totalInstallments ?? 0) > 1) {
    return `${base} - RECIBO cuota ${input.installmentNumber} de ${input.totalInstallments} - ${fecha}.pdf`;
  }
  if (!input.saldaTotal) {
    const monto = Math.round(input.amount);
    return `${base} - RECIBO pago parcial - ${fecha} - $${monto}.pdf`;
  }
  return `${base} - RECIBO ${fecha}.pdf`;
}
```

- [ ] **Step 2: Crear `scripts/test-statements-naming.ts` (verificación)**

```ts
import {
  sanitizeName, buildStatementPeriodFolderName, buildInvoiceFileName, buildReceiptFileName,
} from "@/lib/statementsNaming";

let ok = 0, fail = 0;
function eq(actual: string, expected: string, label: string) {
  if (actual === expected) { ok++; console.log(`✓ ${label}`); }
  else { fail++; console.log(`✗ ${label}\n   esperado: ${expected}\n   actual:   ${actual}`); }
}

eq(buildStatementPeriodFolderName(6, 2026), "2026-06 Junio", "periodo junio");
eq(buildStatementPeriodFolderName(12, 2026), "2026-12 Diciembre", "periodo diciembre");
eq(sanitizeName("AySA/Edesur: 2024"), "AySA Edesur 2024", "sanitizar");

eq(
  buildInvoiceFileName({ provider: "MATAFUEGOS GOMEZ", consortium: "JUNIN 1222", month: 6, year: 2026, boletaNumber: "0005-00009460", documentHash: "abc123def456" }),
  "MATAFUEGOS GOMEZ - JUNIN 1222 - P06-2026 - 0005-00009460.pdf", "boleta con N°"
);
eq(
  buildInvoiceFileName({ provider: "X", consortium: "Y", month: 6, year: 2026, boletaNumber: null, documentHash: "a3f9c2zzzz" }),
  "X - Y - P06-2026 - SN a3f9c2.pdf", "boleta sin N°"
);

const d = new Date(2026, 5, 15); // 15-06-2026
eq(
  buildReceiptFileName({ provider: "X", consortium: "Y", month: 6, year: 2026, boletaNumber: "0005-00009460", documentHash: "h", paymentDate: d, amount: 721571, saldaTotal: true }),
  "X - Y - P06-2026 - 0005-00009460 - RECIBO 15-06-2026.pdf", "recibo único"
);
eq(
  buildReceiptFileName({ provider: "X", consortium: "Y", month: 6, year: 2026, boletaNumber: "0005-00009460", documentHash: "h", paymentDate: d, amount: 240000, installmentNumber: 1, totalInstallments: 3, saldaTotal: false }),
  "X - Y - P06-2026 - 0005-00009460 - RECIBO cuota 1 de 3 - 15-06-2026.pdf", "recibo cuota"
);
eq(
  buildReceiptFileName({ provider: "X", consortium: "Y", month: 6, year: 2026, boletaNumber: "0005-00009460", documentHash: "h", paymentDate: d, amount: 250000, saldaTotal: false }),
  "X - Y - P06-2026 - 0005-00009460 - RECIBO pago parcial - 15-06-2026 - $250000.pdf", "recibo parcial libre"
);

console.log(`\n${ok} ok, ${fail} fail`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 3: Correr la verificación**

Run: `npx tsx scripts/test-statements-naming.ts`
Expected: todas `✓`, `... 0 fail`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/statementsNaming.ts scripts/test-statements-naming.ts
git commit -m "feat: helpers de naming para rendiciones (boleta/recibo/periodo)"
```

---

## Task 3: `GoogleDriveService` — `renameFile` + `shareFolderPublic`

**Files:**
- Modify: `src/services/googleDrive.service.ts`

- [ ] **Step 1: Agregar `renameFile`**

Junto a los otros métodos (después de `uploadFile`):

```ts
  /** Renombra un archivo en Drive. */
  async renameFile(fileId: string, newName: string): Promise<void> {
    await this.drive.files.update({
      fileId,
      requestBody: { name: newName },
      fields: "id,name",
      supportsAllDrives: true,
    });
  }

  /**
   * Comparte una carpeta como "cualquiera con el link" (lector) y devuelve el
   * webViewLink. Para la carpeta de cada edificio (la raíz queda privada).
   */
  async shareFolderPublic(folderId: string): Promise<string> {
    await this.drive.permissions.create({
      fileId: folderId,
      requestBody: { type: "anyone", role: "reader" },
      supportsAllDrives: true,
    });
    const meta = await this.drive.files.get({
      fileId: folderId,
      fields: "webViewLink",
      supportsAllDrives: true,
    });
    return meta.data.webViewLink ?? `https://drive.google.com/drive/folders/${folderId}`;
  }
```

- [ ] **Step 2: Verificar typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sin errores.

- [ ] **Step 3: Commit**

```bash
git add src/services/googleDrive.service.ts
git commit -m "feat: renameFile y shareFolderPublic en GoogleDriveService"
```

---

## Task 4: Orquestador `resolveStatementsFolders`

> Requiere que el owner ya haya corrido `prisma generate` (Task 0) para que `statementsFolderId/Url` existan en el cliente Prisma.

**Files:**
- Create: `src/services/statementsFolders.service.ts`

- [ ] **Step 1: Crear `src/services/statementsFolders.service.ts`**

```ts
import { getPrismaClient } from "@/lib/prisma";
import { GoogleDriveService } from "@/services/googleDrive.service";
import { buildStatementPeriodFolderName, sanitizeName } from "@/lib/statementsNaming";

export interface StatementsFolders {
  buildingFolderId: string;
  periodFolderId: string;
}

/**
 * Crea/obtiene `statements/[Edificio]/[Período]`. La primera vez que se crea la
 * carpeta del edificio, la comparte pública y guarda el link en Consortium.
 * Cachea en memoria por proceso para no repetir llamadas a Drive en un ciclo.
 */
const buildingCache = new Map<string, string>();  // key: statementsRootId|consortiumId
const periodCache = new Map<string, string>();     // key: buildingFolderId|periodName

export async function resolveStatementsFolders(params: {
  drive: GoogleDriveService;
  statementsRootId: string;
  consortium: { id: string; rawName: string; statementsFolderId: string | null };
  month: number;
  year: number;
}): Promise<StatementsFolders> {
  const { drive, statementsRootId, consortium, month, year } = params;
  const prisma = getPrismaClient();

  // 1. Carpeta del edificio
  let buildingFolderId = consortium.statementsFolderId ?? null;
  const bcKey = `${statementsRootId}|${consortium.id}`;
  if (!buildingFolderId) buildingFolderId = buildingCache.get(bcKey) ?? null;

  if (!buildingFolderId) {
    const name = sanitizeName(consortium.rawName) || consortium.id;
    buildingFolderId = await drive.getOrCreateFolder(name, statementsRootId);
    const url = await drive.shareFolderPublic(buildingFolderId);
    await prisma.consortium.update({
      where: { id: consortium.id },
      data: { statementsFolderId: buildingFolderId, statementsFolderUrl: url },
    });
    buildingCache.set(bcKey, buildingFolderId);
  }

  // 2. Carpeta del período
  const periodName = buildStatementPeriodFolderName(month, year);
  const pcKey = `${buildingFolderId}|${periodName}`;
  let periodFolderId = periodCache.get(pcKey) ?? null;
  if (!periodFolderId) {
    periodFolderId = await drive.getOrCreateFolder(periodName, buildingFolderId);
    periodCache.set(pcKey, periodFolderId);
  }

  return { buildingFolderId, periodFolderId };
}
```

- [ ] **Step 2: Verificar typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sin errores (requiere Task 0 aplicada por el owner).

- [ ] **Step 3: Commit**

```bash
git add src/services/statementsFolders.service.ts
git commit -m "feat: resolveStatementsFolders (estructura Edificio/Periodo + share)"
```

---

## Task 5: Integrar en el pipeline (worker)

**Files:**
- Modify: `src/jobs/processPendingDocuments.job.ts`
- Modify: `src/jobs/runProcessingCycle.ts`
- Modify: `src/jobs/jobWorkerMain.ts`

- [ ] **Step 1: Agregar `driveStatementsFolderId` a `ProcessJobConfig`, default y normalizeConfig**

En `processPendingDocuments.job.ts`:
- En `interface ProcessJobConfig`: `driveStatementsFolderId?: string | null;`
- En `buildLegacyConfig` return: `driveStatementsFolderId: null,`
- En `normalizeConfig` return: `driveStatementsFolderId: config.driveStatementsFolderId ?? null,`

- [ ] **Step 2: Propagar desde `runProcessingCycle.ts` y `jobWorkerMain.ts`**

En ambos, donde se arma el objeto de config del job (junto a `driveScannedFolderId: folders.scanned`), agregar:

```ts
        driveStatementsFolderId: folders.statements,
```

- [ ] **Step 3: Reemplazar el destino de boletas OK por la estructura statements**

En `processPendingDocuments.job.ts`, en el bloque que hoy mueve a Escaneados (el `if (isDuplicate && resolvedConfig.driveDuplicatesFolderId) {...} else { moveFileToScanned }`), para el caso **NO duplicado** integrar statements. Localizar dónde se conoce el `consortium` (con `id`, `rawName`, `statementsFolderId`) y el período (`month`, `year` del período activo). Antes del "Mover", agregar:

```ts
// Período del consorcio (red de seguridad — la llave preventiva está en el scheduler)
if (!activePeriod) {
  // consorcio puntual sin período → a Revisión + aviso, no organizar
  pipelineLog.stepStart(cid, `⚠️ Consorcio "${consortium.canonicalName}" sin período activo → Revisión`);
  if (resolvedConfig.driveFailedFolderId && finalSourceFolderId) {
    await driveService.moveFileToFolder(file.id, finalSourceFolderId, resolvedConfig.driveFailedFolderId);
  }
  summary.unassigned += 1;
  pipelineLog.fileCompleted(cid, file.name, { processed: 0, unassigned: 1, duplicate: false });
  return;
}
```

Luego, en el bloque de movimiento del archivo NO duplicado, reemplazar `moveFileToScanned` por:

```ts
if (resolvedConfig.driveStatementsFolderId) {
  const { resolveStatementsFolders } = await import("@/services/statementsFolders.service");
  const { buildInvoiceFileName } = await import("@/lib/statementsNaming");
  const folders = await resolveStatementsFolders({
    drive: driveService,
    statementsRootId: resolvedConfig.driveStatementsFolderId,
    consortium: {
      id: consortium.id,
      rawName: consortium.rawName,
      statementsFolderId: (consortium as any).statementsFolderId ?? null,
    },
    month: activePeriod.month,
    year: activePeriod.year,
  });
  const newName = buildInvoiceFileName({
    provider: extracted!.provider, consortium: consortium.rawName,
    month: activePeriod.month, year: activePeriod.year,
    boletaNumber: extracted!.boletaNumber, documentHash: fileHash,
  });
  await runStep("Renombrar boleta", () => driveService.renameFile(file.id, newName));
  await runStep("Mover a Rendiciones", () =>
    driveService.moveFileToFolder(file.id, finalSourceFolderId!, folders.periodFolderId)
  );
  sourceFileUrl = buildDriveFileUrl(file.id, null);
} else {
  // fallback (no debería pasar: el scheduler valida statements)
  await runStep("Mover a Escaneados", () =>
    driveService.moveFileToScanned(file.id, finalSourceFolderId, resolvedConfig.driveScannedFolderId)
  );
}
```

> Nota: `consortium` debe traer `statementsFolderId`. Verificar el `select` donde se carga el consortium (`consortiumRepository.findByCanonicalName` o el `findMany` de matching) e incluir `statementsFolderId`. Si no, agregarlo al select.

- [ ] **Step 4: Verificar typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sin errores.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/processPendingDocuments.job.ts src/jobs/runProcessingCycle.ts src/jobs/jobWorkerMain.ts
git commit -m "feat: pipeline organiza boletas en Rendiciones/Edificio/Periodo"
```

---

## Task 6: Carga manual → statements

**Files:**
- Modify: `src/app/api/client/consortiums/[id]/invoices/route.ts`

- [ ] **Step 1: Cargar `statementsFolderId` del consorcio y resolver carpeta destino**

En el `findFirst` del consorcio (al inicio del POST) agregar al `select`: `statementsFolderId: true`. Y obtener el período (`month`, `year`) — ya se carga `period`.

- [ ] **Step 2: Reemplazar el destino del upload (hoy `folders.scanned`) por statements**

En el bloque de upload del PDF, reemplazar la resolución de `destFolderId` y el `uploadFile` por:

```ts
const folders = processingClient ? resolveFolders(processingClient) : ({} as ReturnType<typeof resolveFolders>);
if (folders.statements) {
  const { resolveStatementsFolders } = await import("@/services/statementsFolders.service");
  const { buildInvoiceFileName } = await import("@/lib/statementsNaming");
  const sf = await resolveStatementsFolders({
    drive: driveService,
    statementsRootId: folders.statements,
    consortium: { id: consortium.id, rawName: consortium.rawName, statementsFolderId: consortium.statementsFolderId ?? null },
    month: period.month, year: period.year,
  });
  const fileName = buildInvoiceFileName({
    provider: provider.canonicalName, consortium: consortium.rawName,
    month: period.month, year: period.year,
    boletaNumber: body.boletaNumber ?? null, documentHash,
  });
  const uploaded = await driveService.uploadFile(pdfBuffer, fileName, "application/pdf", sf.periodFolderId);
  driveFileId = uploaded.id || null;
  sourceFileUrl = uploaded.webViewLink ?? (uploaded.id ? `https://drive.google.com/file/d/${uploaded.id}/view` : null);
} else {
  driveWarning = "Sin carpeta Rendiciones (statements) configurada, el PDF no se guardó.";
}
```

(El `driveService` ya se instancia en ese bloque; reordenar para instanciarlo antes del `if`.)

- [ ] **Step 3: Verificar typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sin errores.

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/client/consortiums/[id]/invoices/route.ts"
git commit -m "feat: carga manual guarda el PDF en Rendiciones/Edificio/Periodo"
```

---

## Task 7: La "llave" — validación preventiva en el scheduler

**Files:**
- Modify: `src/jobs/scheduler.ts`

- [ ] **Step 1: Validar período activo antes de encolar boletas de un cliente**

En `scheduler.ts`, dentro del loop por cliente, ANTES de listar/encolar PDFs (las carpetas ya las valida `validateClientProcessingConfig` de Task 1, que se llama o debe llamarse acá — verificar; si no se llama, agregar el try/catch que saltee el cliente con log). Agregar:

```ts
const activePeriods = await prisma.period.count({
  where: { consortium: { clientId: client.id }, status: "ACTIVE" },
});
if (activePeriods === 0) {
  schedulerLog.stepStart(client.id, "⛔ Sin períodos activos — no se encolan boletas (abrir período). Reintenta el próximo ciclo.");
  continue; // saltea este cliente
}
```

> Ajustar `schedulerLog`/logger al método de log disponible en el scheduler. Si `validateClientProcessingConfig` no se invoca en el scheduler, envolver el procesamiento del cliente en try/catch y loguear + `continue` cuando lance (carpeta `statements` faltante).

- [ ] **Step 2: Verificar typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sin errores.

- [ ] **Step 3: Commit**

```bash
git add src/jobs/scheduler.ts
git commit -m "feat: scheduler corta ciclo si falta carpeta statements o periodo activo (anti-tokens)"
```

---

## Task 8: Recibos → statements

**Files:**
- Modify: `src/app/api/client/consortiums/[id]/invoices/[invoiceId]/receipt/route.ts`

- [ ] **Step 1: Cambiar destino y naming del recibo**

Reemplazar la resolución de carpeta (hoy `receipts/Consorcio/Período` vía `getOrCreateFolder`) por `resolveStatementsFolders`, y el nombre del archivo por `buildReceiptFileName`. Necesita: el consorcio (`id`, `rawName`, `statementsFolderId`), el período de la invoice (`periodRef.month/year`), y datos del pago.

```ts
const { resolveStatementsFolders } = await import("@/services/statementsFolders.service");
const { buildReceiptFileName } = await import("@/lib/statementsNaming");
// ... validar folders.statements (sino, 400 "Sin carpeta Rendiciones")
const sf = await resolveStatementsFolders({
  drive: driveService,
  statementsRootId: folders.statements!,
  consortium: { id: invoice.consortiumId!, rawName: invoice.consortiumRef!.rawName, statementsFolderId: (invoice.consortiumRef as any).statementsFolderId ?? null },
  month: invoice.periodRef!.month, year: invoice.periodRef!.year,
});
const fileName = buildReceiptFileName({
  provider: invoice.provider, consortium: invoice.consortiumRef!.rawName,
  month: invoice.periodRef!.month, year: invoice.periodRef!.year,
  boletaNumber: invoice.boletaNumber, documentHash: invoice.documentHash,
  paymentDate: new Date(), amount: Number(amount),
  installmentNumber: /* del PaymentRepository result */ null,
  totalInstallments: null,
  saldaTotal: /* result.invoice.isPaid */ true,
});
const uploaded = await driveService.uploadFile(buffer, fileName, "application/pdf", sf.periodFolderId);
```

> Ajustar: incluir `statementsFolderId` y `rawName` en el `include`/`select` del `invoice` (consortiumRef) y `periodRef.month/year`. Para `saldaTotal`/cuotas, usar el resultado de `paymentRepo.createPayment` (`result.invoice.isPaid`, `result.payment.installmentNumber/totalInstallments`). Crear el Payment ANTES de armar el nombre, o renombrar después con `renameFile`.

- [ ] **Step 2: Verificar typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sin errores.

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/client/consortiums/[id]/invoices/[invoiceId]/receipt/route.ts"
git commit -m "feat: recibos se guardan junto a su boleta en Rendiciones"
```

---

## Task 9: Panel — link de rendición por consorcio

**Files:**
- Modify: `src/app/admin/consortiums/page.tsx`

- [ ] **Step 1: Exponer `statementsFolderUrl` en el GET de consorcios**

Verificar que el endpoint que lista consorcios para el panel incluya `statementsFolderUrl` en el select. Si no, agregarlo.

- [ ] **Step 2: Mostrar el link con botón Copiar**

En la vista del consorcio (header o configuración), agregar: si `statementsFolderUrl` existe, mostrarlo con un botón "Copiar" (`navigator.clipboard.writeText`). Si no, mostrar "Pendiente (se genera al procesar la primera boleta)".

- [ ] **Step 3: Verificar typecheck + build local**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sin errores.

- [ ] **Step 4: Commit**

```bash
git add "src/app/admin/consortiums/page.tsx"
git commit -m "feat: panel muestra el link de rendicion por consorcio (para QR)"
```

---

## Task 10: Verificar delete/purga (mover desde parent real)

**Files:**
- Modify (verificar): `src/app/api/client/consortiums/[id]/invoices/[invoiceId]/route.ts`
- Modify (verificar): `src/app/api/admin/clients/[id]/purge/route.ts`

- [ ] **Step 1: Confirmar que el delete mueve desde el parent real → failed**

El delete ya usa `getFileParents` y mueve desde el primer parent conocido a `failed`. Verificar que NO asuma `scanned` rígido: el orden de búsqueda de origen debe incluir cualquier parent (Rendiciones). Si está hardcodeado a `scanned`/`unassigned`, agregar `parents[0]` como fallback (ya existe según el código actual). Destino: `failed` (Revisión) — sin cambios.

- [ ] **Step 2: Purga — mover desde parent real a pending**

Verificar que la purga (`scanned → pending`) también tolere que el archivo esté en Rendiciones (usar `getFileParents`). Ajustar si asume `scanned`.

- [ ] **Step 3: Verificar typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sin errores.

- [ ] **Step 4: Commit (si hubo cambios)**

```bash
git add -A
git commit -m "fix: delete/purga mueven boletas desde su ubicacion real (Rendiciones)"
```

---

## Task 11: Documentación obligatoria

**Files:**
- Modify: `docs/progreso.md`, `docs/decisiones.md`, `CHANGELOG.md`, `CLAUDE.md`

- [ ] **Step 1: Actualizar los 4 archivos**

- `CHANGELOG.md` + `docs/progreso.md`: feature de Rendiciones implementada.
- `docs/decisiones.md`: entrada con las decisiones (árbol invertido, llave del scheduler, naming, etc.) — referenciar el spec.
- `CLAUDE.md`: agregar `statements` a la sección `driveFoldersJson`, los campos `statementsFolderId/Url` en Consortium, y el nuevo flujo del pipeline (paso "Mover a Rendiciones").

- [ ] **Step 2: Commit**

```bash
git add docs/ CHANGELOG.md CLAUDE.md
git commit -m "docs: feature de rendiciones por edificio"
```

---

## Verificación funcional final (tras deploy del owner)

1. Cargar boleta (pipeline y manual) → aparece renombrada en `Rendiciones/[Edificio]/[Período]`, carpeta del edificio compartida, link en panel.
2. Cargar recibo → aparece junto a la boleta con naming correcto.
3. Quitar período activo de un consorcio → su boleta va a Revisión + log. Quitar todos → scheduler corta el ciclo (0 tokens).
4. Eliminar boleta → va a Revisión (failed).
5. Duplicado → sigue yendo a carpeta Duplicados (no a statements).

---

## Orden y dependencias

```
Task 0 (migración, OWNER) ─┬─> Task 4 ─> Task 5 ─> Task 6 ─> Task 8
Task 1 ────────────────────┤            (worker)  (manual)  (recibos)
Task 2 (helpers) ──────────┘
Task 3 (Drive methods) ────┘
Task 7 (scheduler) depende de Task 1.
Task 9 (panel) depende de Task 0 (campo url).
Task 10 (delete/purga) independiente.
Task 11 (docs) al final.
```

**Bloqueante:** Task 0 la ejecuta el owner (migración) antes de Tasks 4+. Coordinar.
