# Gasto fijo de retención — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la retención de un proveedor sea un gasto fijo propio (`kind = RETENCION`) con su obligación mensual, y que factura y retención nunca se pisen: una obligación sólo acepta boletas de su mismo tipo (`Invoice.docKind`).

**Architecture:** Enum `DocKind` compartido por `Invoice.docKind` y `FixedExpense.kind`; unique de gasto fijo pasa a `(consortiumId, providerId, kind)`; `obligationMatchesInvoice` compara el tipo; el pipeline marca `RETENCION` cuando el router dio `LIQ_RETENCION`; el modal ofrece `X` y `X — Retención` por proveedor.

**Tech Stack:** Prisma (migración), Next.js API routes, Vitest (`.test.ts` node + `.test.tsx` jsdom).

**Spec:** `docs/superpowers/specs/2026-09-17-gasto-fijo-retencion-design.md`

**Restricciones:** sin commits ni push (owner), `master`, sin ramas. **Claude NUNCA corre `prisma generate` ni `prisma migrate`**: después de la Task 1 hay un STOP para que el owner regenere el cliente; hasta ahí el typecheck va a fallar en los campos nuevos. PowerShell sin `&&`.

---

## Archivos

| Archivo | Cambio |
|---|---|
| `prisma/schema.prisma` | enum `DocKind`; `Invoice.docKind`; `FixedExpense.kind`; unique nuevo |
| `prisma/migrations/20260917000000_doc_kind_retencion/migration.sql` | nuevo |
| `src/lib/fixedExpense.ts` + test | `kind` en target, match por tipo, validación LSP+RETENCION |
| `src/services/obligation.service.ts` + test | `select` de `kind`/`docKind` en los 3 callers |
| `src/repositories/fixedExpense.repository.ts` | `kind` en input, validación, dedupe y create |
| `src/app/api/client/consortiums/[id]/fixed-expenses/route.ts` | `kind` en `itemSchema` |
| `src/repositories/invoice.repository.ts` | `docKind` en `SaveInvoiceInput` y en create/update |
| `src/jobs/processPendingDocuments.job.ts` + test | `docKind` al guardar y al vincular |
| `src/app/api/client/obligations/overview/route.ts` | `kind` en `fixedExpenses` |
| `src/app/admin/obligaciones/lib/sheetModel.ts` + test | `kind` en `OverviewFixedExpense`; concepto `— Retención` |
| `src/app/admin/obligaciones/lib/availableTargets.ts` + test | dos opciones por proveedor; `expenseKind` |
| `src/app/admin/obligaciones/components/AddFixedExpenseModal.tsx` + test | clave con `expenseKind` |
| `src/app/admin/obligaciones/hooks/useObligationsOverview.ts` + test | POST con `kind` |
| docs | progreso, decisiones, CHANGELOG, CLAUDE.md |

---

### Task 0: Línea de base

- [ ] `npx vitest run` → anotar total (esperado 988).

---

### Task 1: Schema + migración — luego STOP

**Files:** `prisma/schema.prisma`, `prisma/migrations/20260917000000_doc_kind_retencion/migration.sql`.

- [ ] **Step 1:** en `schema.prisma`, junto a los otros enums:
```prisma
/// Tipo de documento: la factura del proveedor o la retención que el consorcio le
/// practica (paquete de liquidación, spec 2026-09-12). Un gasto fijo espera uno
/// u otro; una obligación sólo acepta boletas de su tipo (spec 2026-09-17).
enum DocKind {
  FACTURA
  RETENCION
}
```
En `model Invoice`, después de `paymentMethod`: `docKind DocKind @default(FACTURA)`.
En `model FixedExpense`, después de `description`: `kind DocKind @default(FACTURA)`, y reemplazar `@@unique([consortiumId, providerId])` por `@@unique([consortiumId, providerId, kind])` (actualizar el comentario: "Un gasto fijo por objetivo, tipo y consorcio…").

- [ ] **Step 2:** crear `migration.sql` con el SQL exacto del spec §3.1 (CREATE TYPE, 2 ALTER, backfill de `Invoice`, liberación de obligaciones FACTURA colgadas de retenciones, DROP/CREATE del índice).

- [ ] **Step 3 — STOP.** Avisar al owner: migración pendiente. Él corre, con los procesos parados, `npx prisma migrate deploy` y `npx prisma generate`. **No seguir hasta que confirme**: sin el cliente regenerado, `kind`/`docKind` no existen en los tipos y todo lo que sigue no compila.

---

### Task 2: `lib/fixedExpense.ts` — match por tipo

**Files:** `src/lib/fixedExpense.ts`, `src/lib/fixedExpense.test.ts`.

- [ ] **Step 1: tests que fallan** (agregar):
```ts
describe("obligationMatchesInvoice — tipo (spec 2026-09-17)", () => {
  const mayoral = { providerId: "p1", lspServiceId: null };
  it("FACTURA no acepta una retención del mismo proveedor", () => {
    expect(obligationMatchesInvoice({ ...mayoral, kind: "FACTURA" }, { ...mayoral, docKind: "RETENCION" })).toBe(false);
  });
  it("RETENCION no acepta la factura", () => {
    expect(obligationMatchesInvoice({ ...mayoral, kind: "RETENCION" }, { ...mayoral, docKind: "FACTURA" })).toBe(false);
  });
  it("RETENCION acepta la retención", () => {
    expect(obligationMatchesInvoice({ ...mayoral, kind: "RETENCION" }, { ...mayoral, docKind: "RETENCION" })).toBe(true);
  });
  it("sin tipo de ninguno de los dos lados se comporta como FACTURA/FACTURA", () => {
    expect(obligationMatchesInvoice(mayoral, mayoral)).toBe(true);
  });
});

describe("validateFixedExpenseTarget — tipo", () => {
  it("un LSP no puede ser RETENCION", () => {
    expect(validateFixedExpenseTarget({ providerId: null, lspServiceId: "l1", kind: "RETENCION" })).toMatch(/retenci/i);
  });
});
```
- [ ] **Step 2:** run → FAIL (TS: `kind` no existe en el tipo).
- [ ] **Step 3:**
```ts
import type { DocKind } from "@prisma/client";

export interface FixedExpenseTarget {
  providerId: string | null;
  lspServiceId: string | null;
  /** FACTURA (default) o RETENCION. Sólo un proveedor puede tener retención. */
  kind?: DocKind;
}

export function validateFixedExpenseTarget(t: FixedExpenseTarget): string | null {
  … (lo existente) …
  if (t.kind === "RETENCION" && !hasProvider) {
    return "La retención sólo aplica a un proveedor, no a un servicio (LSP).";
  }
  return null;
}

export function obligationMatchesInvoice(
  target: FixedExpenseTarget,
  invoice: { providerId: string | null; lspServiceId: string | null; docKind?: DocKind }
): boolean {
  // Una obligación sólo acepta boletas de su tipo: la factura y la retención de un
  // mismo proveedor conviven en el período sin pisarse (spec 2026-09-17).
  if ((target.kind ?? "FACTURA") !== (invoice.docKind ?? "FACTURA")) return false;
  … (resto igual) …
}
```
Verificar que `@prisma/client` exporte `DocKind` (lo hace tras `prisma generate`); si el proyecto importa enums de otro lado (`@/generated/…`), seguir esa convención.
- [ ] **Step 4:** run → PASS.

---

### Task 3: `obligation.service.ts` — los 3 callers

**Files:** `src/services/obligation.service.ts`, `src/services/obligation.service.test.ts`.

- [ ] **Step 1: test que falla.** Ver cómo el test existente arma el prisma fake (`fixedExpense.findMany`, `invoice.findMany`, `expenseObligation.create/update`) y agregar:
```ts
  it("factura y retención del mismo proveedor van cada una a la obligación de su tipo, sin importar el orden", async () => {
    // Dos gastos fijos de Mayoral: FACTURA y RETENCION. En el período la retención
    // se creó ANTES que la factura (caso real Pueyrredón/Dogo 09/2026).
    fixedExpense.findMany.mockResolvedValue([
      { id: "fx-fact", providerId: "mayoral", lspServiceId: null, kind: "FACTURA" },
      { id: "fx-ret",  providerId: "mayoral", lspServiceId: null, kind: "RETENCION" },
    ]);
    invoice.findMany.mockResolvedValue([
      { id: "inv-ret",  providerId: "mayoral", lspServiceId: null, docKind: "RETENCION" },
      { id: "inv-fact", providerId: "mayoral", lspServiceId: null, docKind: "FACTURA" },
    ]);
    …
    await generateObligationsForPeriod("per1", prisma);
    // la obligación de fx-fact se vinculó a inv-fact y la de fx-ret a inv-ret
    expect(linkedPairs).toEqual(expect.arrayContaining([["fx-fact", "inv-fact"], ["fx-ret", "inv-ret"]]));
  });

  it("un gasto fijo FACTURA solo NO toma la retención", async () => {
    fixedExpense.findMany.mockResolvedValue([{ id: "fx-fact", providerId: "mayoral", lspServiceId: null, kind: "FACTURA" }]);
    invoice.findMany.mockResolvedValue([{ id: "inv-ret", providerId: "mayoral", lspServiceId: null, docKind: "RETENCION" }]);
    …
    const r = await generateObligationsForPeriod("per1", prisma);
    expect(r.linked).toBe(0);
  });
```
Adaptar nombres (`linkedPairs`, etc.) a los helpers reales del test file.
- [ ] **Step 2:** run → FAIL (se vincula porque el match ignora el tipo… o TS por `kind`).
- [ ] **Step 3:** en los 3 lugares:
  - `generateObligationsForPeriod`: `fixedExpense.findMany({ select: { id, providerId, lspServiceId, kind } })`, `invoice.findMany({ select: { id, providerId, lspServiceId, docKind } })`, y la llamada `obligationMatchesInvoice({ providerId: fx.providerId, lspServiceId: fx.lspServiceId, kind: fx.kind }, { providerId: inv.providerId, lspServiceId: inv.lspServiceId, docKind: inv.docKind })`.
  - `linkInvoiceToObligation`: firma `invoice: { …; docKind?: DocKind }`; `include: { fixedExpense: { select: { providerId, lspServiceId, kind } } }`; pasar `kind`/`docKind`.
  - `syncObligationsForClient`: idem en sus dos `select` y en el match.
- [ ] **Step 4:** run → PASS (y los tests viejos siguen verdes: sin `kind` ⇒ FACTURA).

---

### Task 4: Repositorio + endpoint de gastos fijos

**Files:** `src/repositories/fixedExpense.repository.ts`, `src/app/api/client/consortiums/[id]/fixed-expenses/route.ts`.

- [ ] **Step 1:** `CreateFixedExpenseInput` gana `kind?: DocKind`. En `create`:
```ts
    const target = {
      providerId: input.providerId ?? null,
      lspServiceId: input.lspServiceId ?? null,
      kind: input.kind ?? "FACTURA",
    };
    const err = validateFixedExpenseTarget(target);
    …
    // Dedupe a nivel app: mismo consorcio + mismo objetivo + mismo tipo. La factura y
    // la retención del mismo proveedor son dos gastos fijos distintos (spec 2026-09-17).
    const existing = await this.prisma.fixedExpense.findFirst({
      where: { consortiumId: input.consortiumId, providerId: target.providerId, lspServiceId: target.lspServiceId, kind: target.kind },
    });
    …
    data: { …, kind: target.kind, description: … }
```
- [ ] **Step 2:** `route.ts`: `itemSchema` suma `kind: z.enum(["FACTURA", "RETENCION"]).default("FACTURA")`; pasar `kind: item.kind` al `create` (y al `skipped` si lo reporta).
- [ ] **Step 3:** `npm run typecheck` → limpio en estos dos archivos.

---

### Task 5: Pipeline — `docKind` al guardar y al vincular

**Files:** `src/repositories/invoice.repository.ts`, `src/jobs/processPendingDocuments.job.ts`, `src/jobs/processPendingDocuments.job.test.ts`.

- [ ] **Step 1: tests que fallan** (en `describe("liquidación de retenciones")` y en el test `ok` común):
```ts
    // en "entra sin IA: consorcio y empresa por CUIT…":
      expect(guardada.docKind).toBe("RETENCION");
    // en el test ok de factura común (el primero del archivo), agregar:
      expect(ctx.invoiceRepository.saveProcessedInvoice.mock.calls[0][0].docKind).toBe("FACTURA");
```
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** `SaveInvoiceInput` gana `docKind?: DocKind`; en el `create` y el `update` del upsert: `docKind: input.docKind ?? "FACTURA"`. En `persistStep`:
```ts
          lspServiceId: assignment.lspServiceId, paymentMethod: boleta.paymentMethod,
          // La retención es un documento distinto de la factura del mismo proveedor
          // y sólo cumple obligaciones de su tipo (spec 2026-09-17).
          docKind: ctx.lspProvider === "LIQ_RETENCION" ? "RETENCION" : "FACTURA",
```
y en la llamada a `linkInvoiceToObligation`: `docKind: saved.docKind`.
- [ ] **Step 4:** run → PASS. Red completa verde.

---

### Task 6: Overview + sheetModel

**Files:** `src/app/api/client/obligations/overview/route.ts`, `src/app/admin/obligaciones/lib/sheetModel.ts`, `sheetModel.test.ts`.

- [ ] **Step 1: test que falla** (`sheetModel.test.ts`, en el fixture agregar un `fixedExpenses` con `kind: "RETENCION"` para el mismo proveedor):
```ts
  it("un gasto fijo RETENCION se llama '<razón social> — Retención'", () => {
    const sheets = toSheets(payloadCon({ id: "fx-ret", providerId: "p1", lspServiceId: null, kind: "RETENCION", description: null, active: true, obligation: null }));
    expect(sheets[0].rows.map((r) => r.concepto)).toContain("SEGURO LA CAJA — Retención");
  });
```
(adaptar al helper/fixture real del archivo; todos los fixtures existentes suman `kind: "FACTURA"`).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** `OverviewFixedExpense` gana `kind: "FACTURA" | "RETENCION"`; overview `select` de `fixedExpenses` suma `kind: true` y el mapper lo copia. En `toSheets`:
```ts
      const base = lsp
        ? `${lsp.providerName}${lsp.description ? ` — ${lsp.description}` : ""}`
        : provider?.canonicalName ?? fx.description ?? "—";
      const concepto = fx.kind === "RETENCION" ? `${base} — Retención` : base;
```
- [ ] **Step 4:** run → PASS. `npm run typecheck` (los tests `.tsx` que arman `OverviewFixedExpense` van a pedir `kind`; agregarlo).

---

### Task 7: Modal — dos opciones por proveedor

**Files:** `availableTargets.ts` + test, `AddFixedExpenseModal.tsx` + test, `useObligationsOverview.ts` + test.

- [ ] **Step 1: tests que fallan.**

`availableTargets.test.ts` (los fixtures suman `kind`):
```ts
  it("cada proveedor ofrece factura y retención", () => {
    const out = availableTargets(consortium, providers, "");
    const p2 = out.providers.filter((o) => o.id === "p2").map((o) => [o.label, o.expenseKind]);
    expect(p2).toEqual([["TECNOPAS ASC.", "FACTURA"], ["TECNOPAS ASC. — Retención", "RETENCION"]]);
  });
  it("cargada la factura, sólo queda la retención", () => {
    // p1 está cargado como FACTURA en el fixture
    const out = availableTargets(consortium, providers, "");
    expect(out.providers.filter((o) => o.id === "p1").map((o) => o.expenseKind)).toEqual(["RETENCION"]);
  });
  it("un LSP ofrece una sola opción, FACTURA", () => {
    expect(availableTargets(consortium, providers, "").lsp.map((o) => o.expenseKind)).toEqual(["FACTURA"]);
  });
  it("'retenc' filtra sólo las opciones de retención", () => {
    const out = availableTargets(consortium, providers, "retenc");
    expect(out.providers.every((o) => o.expenseKind === "RETENCION")).toBe(true);
  });
```
`useObligationsOverview.test.tsx`: el POST de una opción `{ kind: "provider", id: "p1", expenseKind: "RETENCION" }` manda `items: [{ providerId: "p1", kind: "RETENCION" }]`.
`AddFixedExpenseModal.test.tsx`: tildar `X` y `X — Retención` del mismo proveedor cuenta 2 seleccionados.

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:**
```ts
export type TargetOption = {
  kind: "provider" | "lsp";
  id: string;
  label: string;
  /** FACTURA o RETENCION. Los LSP son siempre FACTURA. */
  expenseKind: "FACTURA" | "RETENCION";
};

  const usedProvider = new Set(
    consortium.fixedExpenses.filter((fx) => fx.providerId).map((fx) => `${fx.providerId}:${fx.kind}`)
  );
  …
  const provs: TargetOption[] = providers
    .flatMap((p) => [
      { kind: "provider" as const, id: p.id, label: providerLabel(p), expenseKind: "FACTURA" as const },
      { kind: "provider" as const, id: p.id, label: `${providerLabel(p)} — Retención`, expenseKind: "RETENCION" as const },
    ])
    .filter((o) => !usedProvider.has(`${o.id}:${o.expenseKind}`))
    .filter((o) => matches(o.label))
    .sort((a, b) => a.label.localeCompare(b.label, "es"));
```
LSP: `expenseKind: "FACTURA"`. Modal: `const key = \`${option.kind}:${option.id}:${option.expenseKind}\`` (las dos ocurrencias). Hook: `t.kind === "provider" ? { providerId: t.id, kind: t.expenseKind } : { lspServiceId: t.id }`.
- [ ] **Step 4:** run los 3 → PASS.

---

### Task 8: Verificación completa

- [ ] `npm run typecheck` · `npx vitest run` (≈ 988 + 12) · `npm run lint` (13 warnings preexistentes) · `npm run build:jobs` · `npm run build` (toca UI).

---

### Task 9: Documentación

- [ ] `docs/progreso.md`: sección "Gasto fijo de retención (2026-09-17)": estado, migración pendiente/aplicada, pasos del owner (cargar "— Retención" en los 5 edificios, borrar `RETENCIONES VEPS`, verificar Dogo/Pueyrredón liberado).
- [ ] `docs/decisiones.md`: entrada (problema con el caso Dogo, decisión, alternativas, impacto).
- [ ] `CHANGELOG.md`: entrada.
- [ ] `CLAUDE.md`: schema (`DocKind`, `Invoice.docKind`, `FixedExpense.kind`, unique nuevo); sección de obligaciones/modal ("cada proveedor aparece dos veces"); regla "una obligación sólo acepta boletas de su tipo".
- [ ] Avisar "listo para commitear".
