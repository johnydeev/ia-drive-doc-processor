# Refactor `consortiums/page.tsx` — Tanda 1 · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extraer del god-component `src/app/admin/consortiums/page.tsx` (3105 líneas) las piezas de menor riesgo —helpers puros, tipos, constantes, dos modales simples y `PagosView`— a `lib/`, `hooks/` y `components/`, montando de paso la infra de tests de UI (jsdom + testing-library), **sin cambiar ningún comportamiento observable**.

**Architecture:** Cada dominio = un hook (`useX`, encapsula estado + efectos + handlers, cero JSX) + un componente presentacional (recibe props explícitas). La lógica pura sale a `lib/*.ts` con tests node. Los hooks/componentes se testean en jsdom (`*.test.tsx`). `page.tsx` queda como orquestador. Ver spec: `docs/superpowers/specs/2026-07-16-refactor-consortiums-page-design.md`.

**Tech Stack:** Next.js (App Router) · React · TypeScript · Vitest 4 (`test.projects`: node + jsdom) · @testing-library/react + user-event + jest-dom.

**Regla del proyecto:** Claude **no commitea** — cada tarea termina con el árbol verde y el owner commitea. Los pasos "Commit" del plan documentan el mensaje sugerido para que lo ejecute el owner.

---

## Estructura de archivos (destino de la tanda 1)

```
src/app/admin/consortiums/
├── page.tsx                    # MODIFICAR: quita definiciones movidas, importa desde lib/hooks/components
├── page.module.css             # sin cambios (compartido)
├── lib/
│   ├── types.ts                # CREAR: 13 tipos top-level
│   ├── constants.ts            # CREAR: TIPOS_COMPROBANTE, TIPOS_GASTO, LSP_PROVIDERS, EMPTY_INVOICE_FORM
│   ├── format.ts               # CREAR: MONTH_NAMES + 7 helpers de formato/fecha/monto
│   ├── format.test.ts          # CREAR (node)
│   ├── match.ts                # CREAR: matchProvider, normName, slugify, url keys
│   └── match.test.ts           # CREAR (node)
├── hooks/
│   ├── useConsortiumForm.ts     # CREAR
│   ├── useConsortiumForm.test.tsx  # CREAR (jsdom)
│   ├── useProviderForm.ts       # CREAR
│   └── useProviderForm.test.tsx    # CREAR (jsdom)
└── components/
    ├── ConsortiumFormModal.tsx  # CREAR
    ├── ConsortiumFormModal.test.tsx # CREAR (jsdom)
    ├── ProviderFormModal.tsx    # CREAR
    ├── ProviderFormModal.test.tsx   # CREAR (jsdom)
    ├── PagosView.tsx            # CREAR (mudanza de la función existente)
    └── PagosView.test.tsx       # CREAR (jsdom)

Raíz del repo:
├── vitest.config.ts            # MODIFICAR: pasar a test.projects (node + jsdom)
├── vitest.setup.ts             # CREAR
└── package.json                # MODIFICAR: + devDeps de testing
```

**Grafo de dependencias de `lib/` (sin ciclos):** `types.ts` (hoja) ← `format.ts` ← `constants.ts`; `match.ts` → `types.ts` + `@/lib/cuit`.

---

## Task 1: Extraer tipos y constantes a `lib/`

**Files:**
- Create: `src/app/admin/consortiums/lib/types.ts`
- Create: `src/app/admin/consortiums/lib/constants.ts`
- Modify: `src/app/admin/consortiums/page.tsx` (quitar definiciones movidas, agregar imports)

> Nota de orden: `constants.ts` importa `todayInputDate` de `./format`, que se crea en la Task 2. Para que la Task 1 compile por sí sola, `EMPTY_INVOICE_FORM` usa una copia local mínima de `todayInputDate` **solo hasta la Task 2**, donde se reemplaza por el import. (Alternativa más limpia: hacer Task 1 y 2 en un mismo commit. Si el ejecutor prefiere eso, saltar el paso de la copia local y crear `format.ts` antes de `constants.ts`.)

- [ ] **Step 1: Crear `lib/types.ts`**

Copiar textualmente las 13 declaraciones de tipo del tope de `page.tsx` (líneas 22-39, 140-146, 156-158, 171-195) y exportarlas.

```typescript
// src/app/admin/consortiums/lib/types.ts
// Tipos compartidos de la UI de consorcios. Movidos desde page.tsx sin cambios.

export type Period = { id: string; year: number; month: number; status: "ACTIVE" | "CLOSED" };
export type Coeficiente = { id: string; name: string; value: number };
export type Rubro = { id: string; name: string };
export type Consortium = {
  id: string; canonicalName: string; rawName: string; cuit: string | null; cutoffDay: number;
  matchNames: string | null; bank: string | null; statementsFolderUrl: string | null;
  periods: Period[]; _count: { invoices: number };
  activePeriodInvoiceCount: number; activePeriodDebt: number; totalDebt: number;
};
export type Provider = {
  id: string; canonicalName: string; cuit: string | null; paymentAlias: string | null;
  providerType?: "PROVEEDOR" | "EMPLEADO";
};
export type Invoice = {
  id: string; boletaNumber: string | null; provider: string | null; providerTaxId: string | null;
  detail: string | null; observation: string | null; issueDate: string | null; dueDate: string | null;
  amount: number | null; isDuplicate: boolean; isManual: boolean; sourceFileUrl: string | null;
  tipoGasto: string; tipoComprobante: string | null; createdAt: string;
  coeficienteRef: { id: string; name: string; value: number } | null;
  rubroRef: { id: string; name: string } | null;
  isPaid: boolean;
  remainingBalance: number | null;
  lspServiceId: string | null;
  providerType?: "PROVEEDOR" | "EMPLEADO";
};
export type ScannedData = {
  boletaNumber: string | null; provider: string | null; providerTaxId: string | null;
  detail: string | null; observation: string | null; issueDate: string | null;
  dueDate: string | null; amount: number | null; tipoComprobante: string | null;
};
export type InvoiceForm = {
  providerId: string; boletaNumber: string; providerTaxId: string;
  detail: string; observation: string; issueDate: string; dueDate: string;
  amount: string; coeficienteId: string; newCoefName: string; newCoefValue: string;
  rubroId: string; newRubroName: string;
  tipoGasto: string; tipoComprobante: string;
};
export type LspService = {
  id: string; providerName: string; clientNumber: string; description: string | null;
};
export type ThemeMode = "dark" | "light";
export type CloseAllPreview = {
  majorityMonth: string | null;
  nextMonth: string | null;
  toClose: { id: string; canonicalName: string; currentPeriod: string; pendingObligations?: number }[];
  toSkip: { id: string; canonicalName: string; currentPeriod: string }[];
};
export type FixedExpenseRow = {
  id: string; providerId: string | null; lspServiceId: string | null;
  description: string | null; active: boolean;
};
export type ObligationRow = {
  id: string;
  status: "PENDING" | "RECEIVED" | "SKIPPED" | "NOT_RECEIVED";
  fixedExpense: {
    description: string | null;
    provider: { canonicalName: string } | null;
    lspService: { providerName: string; clientNumber: string } | null;
  };
  invoice: { id: string; isPaid: boolean; sourceFileUrl: string | null } | null;
};
```

- [ ] **Step 2: Crear `lib/constants.ts`**

```typescript
// src/app/admin/consortiums/lib/constants.ts
import { todayInputDate } from "./format";
import type { InvoiceForm } from "./types";

export const TIPOS_COMPROBANTE = [
  "A", "B", "C", "E", "M", "X",
  "Ticket", "Recibo", "Liq. Serv. Público", "Otro",
] as const;

export const TIPOS_GASTO = [
  { value: "ORDINARIO",      label: "Ordinario" },
  { value: "EXTRAORDINARIO", label: "Extraordinario" },
  { value: "PARTICULAR",     label: "Particular" },
] as const;

export const LSP_PROVIDERS = [
  { value: "EDESUR",      label: "Edesur" },
  { value: "AYSA",        label: "AySA" },
  { value: "EDENOR",      label: "Edenor" },
  { value: "METROGAS",    label: "Metrogas" },
  { value: "NATURGY",     label: "Naturgy" },
  { value: "CAMUZZI",     label: "Camuzzi" },
  { value: "LITORAL_GAS", label: "Litoral Gas" },
  { value: "PERSONAL",    label: "Personal" },
] as const;

export const EMPTY_INVOICE_FORM: InvoiceForm = {
  providerId: "", boletaNumber: "", providerTaxId: "", detail: "", observation: "",
  issueDate: todayInputDate(), dueDate: "", amount: "",
  coeficienteId: "", newCoefName: "", newCoefValue: "",
  rubroId: "", newRubroName: "",
  tipoGasto: "ORDINARIO", tipoComprobante: "",
};
```

- [ ] **Step 3: Actualizar imports y quitar definiciones en `page.tsx`**

En `page.tsx`, **borrar** las líneas de definición de: los 13 tipos (22-39, 140-146, 156-158, 171-195), `TIPOS_COMPROBANTE` (11-14), `TIPOS_GASTO` (16-20), `LSP_PROVIDERS` (160-169) y `EMPTY_INVOICE_FORM` (148-154). **Dejar por ahora** `MONTH_NAMES` y los helpers de función (se mueven en Tasks 2-3). Agregar al bloque de imports del tope:

```typescript
import type {
  Period, Coeficiente, Rubro, Consortium, Provider, Invoice, ScannedData,
  InvoiceForm, LspService, ThemeMode, CloseAllPreview, FixedExpenseRow, ObligationRow,
} from "./lib/types";
import { TIPOS_COMPROBANTE, TIPOS_GASTO, LSP_PROVIDERS, EMPTY_INVOICE_FORM } from "./lib/constants";
```

- [ ] **Step 4: Verificar typecheck + lint + build**

Run:
```bash
npm run typecheck
npm run lint
npm run build:jobs
```
Expected: 0 errores de types; lint sin errores nuevos (los 13 warnings previos toleran); build:jobs OK.

- [ ] **Step 5: Verificar tests + smoke visual**

Run: `npx vitest run`
Expected: los 299 tests siguen verdes (esta tarea no agrega tests).

Smoke visual: `npm run dev`, abrir `/admin/consortiums`, confirmar que la grilla de consorcios carga y que el modal "Nuevo consorcio" y "Nuevo proveedor" abren y muestran los tipos de comprobante/gasto correctos (usan las constantes movidas).

- [ ] **Step 6: Commit (lo ejecuta el owner)**

```bash
git add src/app/admin/consortiums/lib/types.ts src/app/admin/consortiums/lib/constants.ts src/app/admin/consortiums/page.tsx
git commit -m "refactor(consortiums): extraer tipos y constantes a lib/"
```

---

## Task 2: Extraer helpers de formato a `lib/format.ts` (tier 0 tests)

**Files:**
- Create: `src/app/admin/consortiums/lib/format.ts`
- Create: `src/app/admin/consortiums/lib/format.test.ts`
- Modify: `src/app/admin/consortiums/page.tsx` (quitar helpers movidos, importar; corregir `constants.ts` para importar `todayInputDate`)

- [ ] **Step 1: Escribir el test que falla `lib/format.test.ts`**

```typescript
// src/app/admin/consortiums/lib/format.test.ts
import { describe, it, expect } from "vitest";
import { parseAmountInput, formatAmount, formatPeriod, toInputDate, todayInputDate } from "./format";

describe("parseAmountInput", () => {
  it("es-AR miles+decimales: '97.500,40' → 97500.4", () => {
    expect(parseAmountInput("97.500,40")).toBe(97500.4);
  });
  it("en-US con coma de miles: '97,500.40' → 97500.4", () => {
    expect(parseAmountInput("97,500.40")).toBe(97500.4);
  });
  it("punto decimal simple: '97500.40' → 97500.4", () => {
    expect(parseAmountInput("97500.40")).toBe(97500.4);
  });
  it("coma decimal simple: '97500,40' → 97500.4", () => {
    expect(parseAmountInput("97500,40")).toBe(97500.4);
  });
  it("con símbolo y espacios: '$ 118.000,00' → 118000", () => {
    expect(parseAmountInput("$ 118.000,00")).toBe(118000);
  });
  it("vacío → NaN", () => {
    expect(Number.isNaN(parseAmountInput(""))).toBe(true);
  });
});

describe("formatAmount", () => {
  it("null → '—'", () => expect(formatAmount(null)).toBe("—"));
  it("formatea es-AR con separador de miles y 2 decimales", () => {
    // Assert resiliente al carácter de espacio/símbolo que use ICU
    expect(formatAmount(118000)).toContain("118.000,00");
  });
});

describe("formatPeriod", () => {
  it("null → 'Sin período activo'", () => expect(formatPeriod(null)).toBe("Sin período activo"));
  it("mes/año en español", () =>
    expect(formatPeriod({ id: "p1", year: 2026, month: 7, status: "ACTIVE" })).toBe("Julio 2026"));
});

describe("toInputDate / todayInputDate", () => {
  it("toInputDate recorta a YYYY-MM-DD", () =>
    expect(toInputDate("2026-07-16T00:00:00.000Z")).toBe("2026-07-16"));
  it("toInputDate null → ''", () => expect(toInputDate(null)).toBe(""));
  it("todayInputDate devuelve formato YYYY-MM-DD", () =>
    expect(todayInputDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/));
});
```

- [ ] **Step 2: Correr el test para verlo fallar**

Run: `npx vitest run src/app/admin/consortiums/lib/format.test.ts`
Expected: FAIL — `Failed to resolve import "./format"` (aún no existe).

- [ ] **Step 3: Crear `lib/format.ts`**

Mover textualmente desde `page.tsx` `MONTH_NAMES` (línea 45) y los helpers `formatPeriod`, `formatAmount`, `formatAmountPlain`, `parseAmountInput`, `formatDate`, `toInputDate`, `todayInputDate` (líneas 47-96), exportándolos.

```typescript
// src/app/admin/consortiums/lib/format.ts
// Helpers puros de formato/fecha/monto. Movidos desde page.tsx sin cambios de lógica.
import type { Period } from "./types";

export const MONTH_NAMES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

export function formatPeriod(p: Period | null | undefined) {
  if (!p) return "Sin período activo";
  return `${MONTH_NAMES[p.month - 1]} ${p.year}`;
}
export function formatAmount(v: number | null | undefined) {
  if (v == null) return "—";
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2 }).format(v);
}
// Formato es-AR sin símbolo de moneda — útil para placeholders de inputs.
export function formatAmountPlain(v: number | null | undefined) {
  if (v == null) return "";
  return new Intl.NumberFormat("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
}
// Acepta lo que el usuario tipea: "97500,40", "97.500,40", "97500.40", "97,500.40".
export function parseAmountInput(raw: string): number {
  if (!raw) return NaN;
  const cleaned = raw.replace(/\s/g, "").replace(/[^\d.,-]/g, "");
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized: string;
  if (lastComma > lastDot) {
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else if (lastDot > lastComma) {
    normalized = cleaned.replace(/,/g, "");
  } else {
    normalized = cleaned.replace(",", ".");
  }
  return Number(normalized);
}
export function formatDate(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  // Las fechas son "date-only" guardadas a medianoche UTC (issueDate, dueDate,
  // paymentDate). Se formatean en UTC para no restar el offset de AR (UTC-3),
  // que mostraría el día anterior.
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("es-AR", { timeZone: "UTC" });
}
export function toInputDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}
export function todayInputDate(): string {
  // Fecha local (no UTC): en la madrugada AR, toISOString() devolvería el día anterior.
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
```

- [ ] **Step 4: Correr el test para verlo pasar**

Run: `npx vitest run src/app/admin/consortiums/lib/format.test.ts`
Expected: PASS (todos los `describe` verdes).

- [ ] **Step 5: Actualizar `page.tsx` y `constants.ts`**

En `page.tsx`: borrar `MONTH_NAMES` (45) y los 7 helpers (47-96). Agregar al import:

```typescript
import {
  MONTH_NAMES, formatPeriod, formatAmount, formatAmountPlain,
  parseAmountInput, formatDate, toInputDate, todayInputDate,
} from "./lib/format";
```

(El uso de `MONTH_NAMES` en `page.tsx:1019` y de `todayInputDate` en `page.tsx:1206` ahora resuelven vía este import.) Confirmar que `constants.ts` ya importa `todayInputDate` desde `./format` (quedó así en la Task 1, Step 2).

- [ ] **Step 6: Verificar todo**

Run:
```bash
npm run typecheck
npm run lint
npx vitest run
npm run build:jobs
```
Expected: 0 errores; 299 + 13 tests nuevos verdes.

Smoke visual: `npm run dev` → `/admin/consortiums` → confirmar montos formateados ("$ 118.000,00"), períodos ("Julio 2026") y fechas se ven igual que antes.

- [ ] **Step 7: Commit (owner)**

```bash
git add src/app/admin/consortiums/lib/format.ts src/app/admin/consortiums/lib/format.test.ts src/app/admin/consortiums/lib/constants.ts src/app/admin/consortiums/page.tsx
git commit -m "refactor(consortiums): extraer helpers de formato a lib/format con tests"
```

---

## Task 3: Extraer helpers de matching a `lib/match.ts` (tier 0 tests)

**Files:**
- Create: `src/app/admin/consortiums/lib/match.ts`
- Create: `src/app/admin/consortiums/lib/match.test.ts`
- Modify: `src/app/admin/consortiums/page.tsx`

- [ ] **Step 1: Escribir el test que falla `lib/match.test.ts`**

```typescript
// src/app/admin/consortiums/lib/match.test.ts
import { describe, it, expect } from "vitest";
import { matchProvider, normName, slugifyName, consortiumUrlKey, idFromUrlKey } from "./match";
import type { Provider, ScannedData } from "./types";

const providers: Provider[] = [
  { id: "p1", canonicalName: "TIGRE ASCENSORES S.A.", cuit: "27-33906838-6", paymentAlias: "TIGRE" },
  { id: "p2", canonicalName: "ASCENSORES POTENZA", cuit: "30-11111111-2", paymentAlias: null },
];

// Factory: ScannedData completo con overrides.
const scanned = (over: Partial<ScannedData>): ScannedData => ({
  boletaNumber: null, provider: null, providerTaxId: null, detail: null,
  observation: null, issueDate: null, dueDate: null, amount: null, tipoComprobante: null,
  ...over,
});

describe("matchProvider", () => {
  it("matchea por CUIT normalizado (dígitos, con o sin guiones)", () => {
    expect(matchProvider(providers, scanned({ providerTaxId: "27339068386" }))?.id).toBe("p1");
  });
  it("matchea por nombre canónico cuando no hay CUIT", () => {
    expect(matchProvider(providers, scanned({ provider: "tigre ascensores s.a." }))?.id).toBe("p1");
  });
  it("matchea por alias de pago", () => {
    expect(matchProvider(providers, scanned({ provider: "tigre" }))?.id).toBe("p1");
  });
  it("sin coincidencia → undefined", () => {
    expect(matchProvider(providers, scanned({ providerTaxId: "30-99999999-9", provider: "otro" }))).toBeUndefined();
  });
});

describe("normName", () => {
  it("baja a minúsculas y colapsa separadores", () => {
    expect(normName("Av. PUEYRREDON_2418")).toBe("av pueyrredon 2418");
  });
});

describe("slugify + url keys", () => {
  it("slugifyName saca acentos y arma slug", () => {
    expect(slugifyName("Av. PUEYRREDÓN 2418")).toBe("av-pueyrredon-2418");
  });
  it("consortiumUrlKey = slug + id", () => {
    expect(consortiumUrlKey({ id: "abc123", canonicalName: "THAMES 647", rawName: "" })).toBe("thames-647-abc123");
  });
  it("idFromUrlKey recupera el id (último segmento tras el guión)", () => {
    expect(idFromUrlKey("thames-647-abc123")).toBe("abc123");
  });
  it("idFromUrlKey sin guión devuelve la clave tal cual", () => {
    expect(idFromUrlKey("abc123")).toBe("abc123");
  });
});
```

- [ ] **Step 2: Correr el test para verlo fallar**

Run: `npx vitest run src/app/admin/consortiums/lib/match.test.ts`
Expected: FAIL — `Failed to resolve import "./match"`.

- [ ] **Step 3: Crear `lib/match.ts`**

Mover textualmente `normName`, `slugifyName`, `consortiumUrlKey`, `idFromUrlKey`, `matchProvider` (líneas 98-138). El comentario de la línea 97 aclara que `normCuit` viene de `@/lib/cuit`.

```typescript
// src/app/admin/consortiums/lib/match.ts
// Helpers de normalización + matching de proveedor + deep-link. Movidos desde page.tsx.
import { cuitDigits as normCuit } from "@/lib/cuit";
import type { Provider, ScannedData } from "./types";

// normCuit: usar la fuente única lib/cuit (los CUITs de DB pueden venir con o sin guiones).
export function normName(v: string | null | undefined): string {
  return (v ?? "").toLowerCase().replace(/[.,\-_]/g, " ").replace(/\s+/g, " ").trim();
}

// ── Deep-link híbrido: URL legible + id inmutable ────────────────────────────
// El slug (del nombre) es cosmético; el matching usa el id (cuid, sin guiones)
// embebido al final → aunque renombres el consorcio, el link viejo sigue andando.
export function slugifyName(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // saca acentos (PUEYRREDÓN → pueyrredon)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
export function consortiumUrlKey(c: { id: string; canonicalName: string; rawName: string }): string {
  const slug = slugifyName(c.canonicalName || c.rawName);
  return slug ? `${slug}-${c.id}` : c.id;
}
// El id (cuid) es el último segmento tras el último guión (el cuid no tiene guiones).
export function idFromUrlKey(key: string | null | undefined): string {
  if (!key) return "";
  const idx = key.lastIndexOf("-");
  return idx >= 0 ? key.slice(idx + 1) : key;
}
export function matchProvider(providers: Provider[], extracted: ScannedData): Provider | undefined {
  if (extracted.providerTaxId) {
    const norm = normCuit(extracted.providerTaxId);
    if (norm.length >= 10) {
      const hit = providers.find((p) => normCuit(p.cuit) === norm);
      if (hit) return hit;
    }
  }
  if (extracted.provider) {
    const norm = normName(extracted.provider);
    if (norm.length >= 3) {
      const hit = providers.find((p) => normName(p.canonicalName) === norm || (p.paymentAlias && normName(p.paymentAlias) === norm));
      if (hit) return hit;
    }
  }
  return undefined;
}
```

> Nota: en el original la línea 108 usa un rango de acentos literal; en el plan se escribe como `̀-ͯ` (equivalente, evita problemas de encoding al copiar). Verificar en el smoke que el slug de un consorcio con acento sigue igual.

- [ ] **Step 4: Correr el test para verlo pasar**

Run: `npx vitest run src/app/admin/consortiums/lib/match.test.ts`
Expected: PASS.

- [ ] **Step 5: Actualizar `page.tsx`**

Borrar de `page.tsx` las funciones movidas (98-138) y el comentario 97. Agregar import:

```typescript
import { matchProvider, normName, slugifyName, consortiumUrlKey, idFromUrlKey } from "./lib/match";
```

Revisar el import de la línea 7 (`import { cuitDigits as normCuit } from "@/lib/cuit"`): si tras mover `matchProvider` ya no se usa `normCuit` en `page.tsx`, **quitarlo** (lint lo marcará como no usado). Si sigue usándose en otra parte, dejarlo.

- [ ] **Step 6: Verificar todo**

Run:
```bash
npm run typecheck
npm run lint
npx vitest run
npm run build:jobs
```
Expected: 0 errores; tests verdes (299 + 13 + 9 nuevos).

Smoke visual: `npm run dev` → abrir un consorcio (verifica `consortiumUrlKey`/`idFromUrlKey` en la URL) y abrir el modal de nueva boleta con un PDF escaneado que matchee un proveedor (verifica `matchProvider`).

- [ ] **Step 7: Commit (owner)**

```bash
git add src/app/admin/consortiums/lib/match.ts src/app/admin/consortiums/lib/match.test.ts src/app/admin/consortiums/page.tsx
git commit -m "refactor(consortiums): extraer matching de proveedor a lib/match con tests"
```

---

## Task 4: Montar la infra de tests de UI (jsdom + testing-library)

**Files:**
- Modify: `package.json` (devDependencies)
- Modify: `vitest.config.ts`
- Create: `vitest.setup.ts`
- Create: `src/test/jsdom-smoke.test.tsx` (test trivial de validación de infra)

> Este paso se aísla en su propio commit: NO mezcla extracción de código, solo infra. Riesgo: bajo pero es config → se valida que los 299 tests node sigan intactos.

- [ ] **Step 1: Instalar devDependencies**

Run:
```bash
npm install -D jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom
```
Expected: se agregan a `devDependencies` en `package.json`. (No tocar `dependencies`.)

- [ ] **Step 2: Crear `vitest.setup.ts`**

```typescript
// vitest.setup.ts — setup del proyecto jsdom: matchers de jest-dom + cleanup por test.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
```

- [ ] **Step 3: Reescribir `vitest.config.ts` con `test.projects`**

Sintaxis de Vitest 4 (`test.projects`, con `extends: true` para heredar el plugin `tsconfigPaths` de la raíz). Split por extensión: `*.test.ts` → node (los 299 actuales, intactos); `*.test.tsx` → jsdom.

```typescript
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Config de Vitest. `vite-tsconfig-paths` resuelve el alias `@/*` → `src/*`
 * leyendo tsconfig.json (robusto multiplataforma, incluido Windows).
 *
 * Dos proyectos por extensión de archivo:
 *  - "node":  lógica pura de librerías/backend (*.test.ts).
 *  - "jsdom": hooks y componentes React (*.test.tsx) con testing-library.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["./vitest.setup.ts"],
        },
      },
    ],
  },
});
```

- [ ] **Step 4: Crear el test de validación de infra `src/test/jsdom-smoke.test.tsx`**

```tsx
// src/test/jsdom-smoke.test.tsx — valida que el entorno jsdom + testing-library + jest-dom funciona.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

describe("infra jsdom", () => {
  it("renderiza un componente y expone matchers de jest-dom", () => {
    render(<div>hola jsdom</div>);
    expect(screen.getByText("hola jsdom")).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Correr toda la suite (ambos proyectos)**

Run: `npx vitest run`
Expected: PASS. El resumen muestra los **dos proyectos** (`node` y `jsdom`); los 299 tests `*.test.ts` corren en node sin cambios y el nuevo `*.test.tsx` corre en jsdom. Verificar explícitamente que el conteo previo (299 + los de Tasks 2-3) sigue verde.

- [ ] **Step 6: Verificar typecheck/lint/build**

Run:
```bash
npm run typecheck
npm run lint
npm run build:jobs
```
Expected: 0 errores.

- [ ] **Step 7: Commit (owner)**

```bash
git add package.json package-lock.json vitest.config.ts vitest.setup.ts src/test/jsdom-smoke.test.tsx
git commit -m "test(infra): montar proyecto jsdom + testing-library para tests de UI"
```

---

## Task 5: Extraer el modal "Crear Consorcio" (hook + componente + tests)

**Files:**
- Create: `src/app/admin/consortiums/hooks/useConsortiumForm.ts`
- Create: `src/app/admin/consortiums/hooks/useConsortiumForm.test.tsx`
- Create: `src/app/admin/consortiums/components/ConsortiumFormModal.tsx`
- Create: `src/app/admin/consortiums/components/ConsortiumFormModal.test.tsx`
- Modify: `src/app/admin/consortiums/page.tsx`

**Interfaz del hook:** `useConsortiumForm(onCreated: () => void)` → `{ isOpen, open, close, form, setField, error, success, saving, submit }`.

- [ ] **Step 1: Escribir el test del hook `useConsortiumForm.test.tsx`**

```tsx
// src/app/admin/consortiums/hooks/useConsortiumForm.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useConsortiumForm } from "./useConsortiumForm";

const guardedFetch = vi.fn();
vi.mock("@/lib/useAuthGuard", () => ({ useAuthGuard: () => ({ guardedFetch }) }));

beforeEach(() => guardedFetch.mockReset());

describe("useConsortiumForm", () => {
  it("open/close alterna isOpen y limpia mensajes", () => {
    const { result } = renderHook(() => useConsortiumForm(() => {}));
    expect(result.current.isOpen).toBe(false);
    act(() => result.current.open());
    expect(result.current.isOpen).toBe(true);
    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
  });

  it("submit con nombre vacío setea error y NO llama al fetch", async () => {
    const { result } = renderHook(() => useConsortiumForm(() => {}));
    await act(async () => { await result.current.submit(); });
    expect(result.current.error).toBe("El nombre del consorcio es obligatorio");
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("submit OK: llama onCreated, setea success y resetea el form", async () => {
    guardedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    const onCreated = vi.fn();
    const { result } = renderHook(() => useConsortiumForm(onCreated));
    act(() => result.current.setField({ canonicalName: "THAMES 647" }));
    await act(async () => { await result.current.submit(); });
    await waitFor(() => expect(result.current.success).toBe("Consorcio creado correctamente."));
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(result.current.form.canonicalName).toBe("");
  });

  it("submit con error del backend setea error", async () => {
    guardedFetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ ok: false, error: "CUIT inválido" }) });
    const { result } = renderHook(() => useConsortiumForm(() => {}));
    act(() => result.current.setField({ canonicalName: "X" }));
    await act(async () => { await result.current.submit(); });
    await waitFor(() => expect(result.current.error).toBe("CUIT inválido"));
  });
});
```

- [ ] **Step 2: Correr el test para verlo fallar**

Run: `npx vitest run src/app/admin/consortiums/hooks/useConsortiumForm.test.tsx`
Expected: FAIL — no existe `./useConsortiumForm`.

- [ ] **Step 3: Crear el hook `useConsortiumForm.ts`**

Reproduce la lógica de `handleSaveConsortium` (page.tsx 1226-1242) + el estado asociado (`showConsortiumModal`, `consortiumForm`, `consortiumError`, `consortiumSuccess`) + `useAsyncAction` (línea 526).

```tsx
// src/app/admin/consortiums/hooks/useConsortiumForm.ts
import { useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import { useAsyncAction } from "@/lib/useAsyncAction";

export type ConsortiumFormValues = { canonicalName: string; cuit: string };
const EMPTY: ConsortiumFormValues = { canonicalName: "", cuit: "" };

export function useConsortiumForm(onCreated: () => void) {
  const { guardedFetch } = useAuthGuard();
  const { pending: saving, run } = useAsyncAction();
  const [isOpen, setIsOpen] = useState(false);
  const [form, setForm] = useState<ConsortiumFormValues>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const open = () => { setError(null); setSuccess(null); setIsOpen(true); };
  const close = () => setIsOpen(false);
  const setField = (patch: Partial<ConsortiumFormValues>) => setForm((f) => ({ ...f, ...patch }));

  const save = async () => {
    if (!form.canonicalName.trim()) { setError("El nombre del consorcio es obligatorio"); return; }
    setError(null); setSuccess(null);
    try {
      const res = await guardedFetch("/api/client/consortiums", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ canonicalName: form.canonicalName.trim(), cuit: form.cuit.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSuccess("Consorcio creado correctamente.");
      setForm(EMPTY);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al guardar el consorcio");
    }
  };

  const submit = () => run(save);

  return { isOpen, open, close, form, setField, error, success, saving, submit };
}
```

- [ ] **Step 4: Correr el test del hook para verlo pasar**

Run: `npx vitest run src/app/admin/consortiums/hooks/useConsortiumForm.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Escribir el test del componente `ConsortiumFormModal.test.tsx`**

```tsx
// src/app/admin/consortiums/components/ConsortiumFormModal.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConsortiumFormModal } from "./ConsortiumFormModal";

function setup(overrides: Partial<React.ComponentProps<typeof ConsortiumFormModal>> = {}) {
  const props = {
    form: { canonicalName: "", cuit: "" },
    onChange: vi.fn(),
    onClose: vi.fn(),
    onSubmit: vi.fn(),
    saving: false,
    error: null as string | null,
    success: null as string | null,
    ...overrides,
  };
  render(<ConsortiumFormModal {...props} />);
  return props;
}

describe("ConsortiumFormModal", () => {
  it("escribir el nombre dispara onChange con el patch", async () => {
    const props = setup();
    await userEvent.type(screen.getByPlaceholderText(/Consorcio Av/), "T");
    expect(props.onChange).toHaveBeenCalledWith({ canonicalName: "T" });
  });
  it("click en 'Crear consorcio' dispara onSubmit", async () => {
    const props = setup();
    await userEvent.click(screen.getByRole("button", { name: /Crear consorcio/ }));
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });
  it("muestra el mensaje de error", () => {
    setup({ error: "algo falló" });
    expect(screen.getByText("algo falló")).toBeInTheDocument();
  });
  it("saving deshabilita el submit y muestra 'Creando...'", () => {
    setup({ saving: true });
    expect(screen.getByRole("button", { name: /Creando/ })).toBeDisabled();
  });
});
```

- [ ] **Step 6: Correr el test del componente para verlo fallar**

Run: `npx vitest run src/app/admin/consortiums/components/ConsortiumFormModal.test.tsx`
Expected: FAIL — no existe `./ConsortiumFormModal`.

- [ ] **Step 7: Crear el componente `ConsortiumFormModal.tsx`**

JSX movido de page.tsx (2255-2280), con estado reemplazado por props. `savingConsortium`→`saving`, `consortiumForm`→`form`, `setConsortiumForm(...)`→`onChange({...})`, `setShowConsortiumModal(false)`→`onClose`, `runConsortium(handleSaveConsortium)`→`onSubmit`.

```tsx
// src/app/admin/consortiums/components/ConsortiumFormModal.tsx
import styles from "../page.module.css";
import type { ConsortiumFormValues } from "../hooks/useConsortiumForm";

type Props = {
  form: ConsortiumFormValues;
  onChange: (patch: Partial<ConsortiumFormValues>) => void;
  onClose: () => void;
  onSubmit: () => void;
  saving: boolean;
  error: string | null;
  success: string | null;
};

export function ConsortiumFormModal({ form, onChange, onClose, onSubmit, saving, error, success }: Props) {
  return (
    <div className={styles.modalOverlay} onClick={() => !saving && onClose()}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>Nuevo consorcio</h3>
        <p className={styles.modalBody}>Se creará con un período activo para el mes en curso.</p>
        <div className={styles.providerFormGrid}>
          <div className={`${styles.formField} ${styles.formFieldFull}`}>
            <label>Nombre del consorcio *</label>
            <input className={styles.formInput} value={form.canonicalName} onChange={(e) => onChange({ canonicalName: e.target.value })} placeholder="Ej: Consorcio Av. Corrientes 1234" />
          </div>
          <div className={`${styles.formField} ${styles.formFieldFull}`}>
            <label>CUIT (opcional)</label>
            <input className={styles.formInput} value={form.cuit} onChange={(e) => onChange({ cuit: e.target.value })} placeholder="30-12345678-9" />
          </div>
        </div>
        {error && <p className={styles.errorMsg}>{error}</p>}
        {success && <p className={styles.infoMsg}>{success}</p>}
        <div className={styles.modalActions}>
          <button type="button" className={styles.ghostBtn} onClick={onClose} disabled={saving}>Cerrar</button>
          <button type="button" className={styles.consortiumBtn} onClick={onSubmit} disabled={saving}>
            {saving ? "Creando..." : "Crear consorcio"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Correr el test del componente para verlo pasar**

Run: `npx vitest run src/app/admin/consortiums/components/ConsortiumFormModal.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 9: Cablear en `page.tsx`**

1. Borrar el estado y handler del consorcio: `showConsortiumModal`/`setShowConsortiumModal` (524), `consortiumForm`/`setConsortiumForm` (525), `consortiumError` (527), `consortiumSuccess` (528), `savingConsortium`/`runConsortium` (526), y `handleSaveConsortium` (1226-1242).
2. Agregar el hook (junto al resto de hooks del componente, después de obtener `fetchConsortiums`):

```tsx
const consortium = useConsortiumForm(fetchConsortiums);
```

3. Import al tope:

```tsx
import { useConsortiumForm } from "./hooks/useConsortiumForm";
import { ConsortiumFormModal } from "./components/ConsortiumFormModal";
```

4. Reemplazar el botón de apertura (línea ~1429) por `onClick={consortium.open}`:

```tsx
<button type="button" className={styles.consortiumBtn} onClick={consortium.open}>
```
*(conservar el resto del botón — icono/label — tal cual estaba).*

5. Reemplazar el bloque JSX del modal (2254-2280, comentario incluido) por:

```tsx
{/* ── Consortium modal ── */}
{consortium.isOpen && (
  <ConsortiumFormModal
    form={consortium.form}
    onChange={consortium.setField}
    onClose={consortium.close}
    onSubmit={consortium.submit}
    saving={consortium.saving}
    error={consortium.error}
    success={consortium.success}
  />
)}
```

- [ ] **Step 10: Verificar todo**

Run:
```bash
npm run typecheck
npm run lint
npx vitest run
npm run build:jobs
```
Expected: 0 errores; todos los tests verdes (incluidos los 8 nuevos de esta tarea).

Smoke visual: `npm run dev` → `/admin/consortiums` → botón "Nuevo consorcio": abre, valida nombre vacío (muestra error), crea uno de prueba (aparece en la grilla vía `fetchConsortiums`), y el backdrop no cierra mientras guarda.

- [ ] **Step 11: Commit (owner)**

```bash
git add src/app/admin/consortiums/hooks/useConsortiumForm.ts src/app/admin/consortiums/hooks/useConsortiumForm.test.tsx src/app/admin/consortiums/components/ConsortiumFormModal.tsx src/app/admin/consortiums/components/ConsortiumFormModal.test.tsx src/app/admin/consortiums/page.tsx
git commit -m "refactor(consortiums): extraer modal Crear Consorcio a hook + componente con tests"
```

---

## Task 6: Extraer el modal "Crear Proveedor" (hook + componente + tests)

**Files:**
- Create: `src/app/admin/consortiums/hooks/useProviderForm.ts`
- Create: `src/app/admin/consortiums/hooks/useProviderForm.test.tsx`
- Create: `src/app/admin/consortiums/components/ProviderFormModal.tsx`
- Create: `src/app/admin/consortiums/components/ProviderFormModal.test.tsx`
- Modify: `src/app/admin/consortiums/page.tsx`

**Interfaz del hook:** `useProviderForm(onCreated: (provider: Provider) => void)` → `{ isOpen, open, close, form, setField, error, success, saving, submit }`. El mensaje de éxito incluye el aviso de reencolado (`data.requeued`) igual que el original (page.tsx 1218-1219).

- [ ] **Step 1: Escribir el test del hook `useProviderForm.test.tsx`**

```tsx
// src/app/admin/consortiums/hooks/useProviderForm.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useProviderForm } from "./useProviderForm";

const guardedFetch = vi.fn();
vi.mock("@/lib/useAuthGuard", () => ({ useAuthGuard: () => ({ guardedFetch }) }));

beforeEach(() => guardedFetch.mockReset());

const provider = { id: "p1", canonicalName: "TIGRE", cuit: "27-33906838-6", paymentAlias: null };

describe("useProviderForm", () => {
  it("submit sin razón social o CUIT setea error y no llama al fetch", async () => {
    const { result } = renderHook(() => useProviderForm(() => {}));
    act(() => result.current.setField({ canonicalName: "TIGRE" })); // falta CUIT
    await act(async () => { await result.current.submit(); });
    expect(result.current.error).toBe("Razón social y CUIT son obligatorios");
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("submit OK: llama onCreated con el provider y resetea el form", async () => {
    guardedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, provider, requeued: 0 }) });
    const onCreated = vi.fn();
    const { result } = renderHook(() => useProviderForm(onCreated));
    act(() => result.current.setField({ canonicalName: "TIGRE", cuit: "27-33906838-6" }));
    await act(async () => { await result.current.submit(); });
    await waitFor(() => expect(result.current.success).toContain("Proveedor creado correctamente."));
    expect(onCreated).toHaveBeenCalledWith(provider);
    expect(result.current.form.canonicalName).toBe("");
  });

  it("submit OK con reencolado incluye el aviso en el success", async () => {
    guardedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, provider, requeued: 3 }) });
    const { result } = renderHook(() => useProviderForm(() => {}));
    act(() => result.current.setField({ canonicalName: "TIGRE", cuit: "27-33906838-6" }));
    await act(async () => { await result.current.submit(); });
    await waitFor(() => expect(result.current.success).toContain("3 boleta(s)"));
  });
});
```

- [ ] **Step 2: Correr el test para verlo fallar**

Run: `npx vitest run src/app/admin/consortiums/hooks/useProviderForm.test.tsx`
Expected: FAIL — no existe `./useProviderForm`.

- [ ] **Step 3: Crear el hook `useProviderForm.ts`**

Reproduce `handleSaveProvider` (page.tsx 1210-1224) + estado (`showProviderModal` 518, `providerForm` 519, `providerError` 521, `providerSuccess` 522) + `useAsyncAction` (520). En vez de `setProviders(...)` inline, delega en `onCreated(provider)`.

```tsx
// src/app/admin/consortiums/hooks/useProviderForm.ts
import { useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import { useAsyncAction } from "@/lib/useAsyncAction";
import type { Provider } from "../lib/types";

export type ProviderFormValues = { canonicalName: string; cuit: string; paymentAlias: string };
const EMPTY: ProviderFormValues = { canonicalName: "", cuit: "", paymentAlias: "" };

export function useProviderForm(onCreated: (provider: Provider) => void) {
  const { guardedFetch } = useAuthGuard();
  const { pending: saving, run } = useAsyncAction();
  const [isOpen, setIsOpen] = useState(false);
  const [form, setForm] = useState<ProviderFormValues>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const open = () => { setError(null); setSuccess(null); setIsOpen(true); };
  const close = () => setIsOpen(false);
  const setField = (patch: Partial<ProviderFormValues>) => setForm((f) => ({ ...f, ...patch }));

  const save = async () => {
    if (!form.canonicalName || !form.cuit) { setError("Razón social y CUIT son obligatorios"); return; }
    setError(null); setSuccess(null);
    try {
      const res = await guardedFetch("/api/client/providers", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      onCreated(data.provider);
      const requeuedMsg = data.requeued > 0 ? ` Se reencolarán ${data.requeued} boleta(s) para revalidación.` : "";
      setSuccess(`Proveedor creado correctamente.${requeuedMsg}`);
      setForm(EMPTY);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al guardar el proveedor");
    }
  };

  const submit = () => run(save);

  return { isOpen, open, close, form, setField, error, success, saving, submit };
}
```

- [ ] **Step 4: Correr el test del hook para verlo pasar**

Run: `npx vitest run src/app/admin/consortiums/hooks/useProviderForm.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Escribir el test del componente `ProviderFormModal.test.tsx`**

```tsx
// src/app/admin/consortiums/components/ProviderFormModal.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProviderFormModal } from "./ProviderFormModal";

function setup(overrides: Partial<React.ComponentProps<typeof ProviderFormModal>> = {}) {
  const props = {
    form: { canonicalName: "", cuit: "", paymentAlias: "" },
    onChange: vi.fn(),
    onClose: vi.fn(),
    onSubmit: vi.fn(),
    saving: false,
    error: null as string | null,
    success: null as string | null,
    ...overrides,
  };
  render(<ProviderFormModal {...props} />);
  return props;
}

describe("ProviderFormModal", () => {
  it("escribir el CUIT dispara onChange con el patch", async () => {
    const props = setup();
    await userEvent.type(screen.getByPlaceholderText("20-12345678-9"), "2");
    expect(props.onChange).toHaveBeenCalledWith({ cuit: "2" });
  });
  it("click en 'Crear proveedor' dispara onSubmit", async () => {
    const props = setup();
    await userEvent.click(screen.getByRole("button", { name: /Crear proveedor/ }));
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });
  it("saving deshabilita el submit y muestra 'Guardando...'", () => {
    setup({ saving: true });
    expect(screen.getByRole("button", { name: /Guardando/ })).toBeDisabled();
  });
});
```

- [ ] **Step 6: Correr el test del componente para verlo fallar**

Run: `npx vitest run src/app/admin/consortiums/components/ProviderFormModal.test.tsx`
Expected: FAIL — no existe `./ProviderFormModal`.

- [ ] **Step 7: Crear el componente `ProviderFormModal.tsx`**

JSX movido de page.tsx (2223-2252), estado → props (mismo criterio que Task 5).

```tsx
// src/app/admin/consortiums/components/ProviderFormModal.tsx
import styles from "../page.module.css";
import type { ProviderFormValues } from "../hooks/useProviderForm";

type Props = {
  form: ProviderFormValues;
  onChange: (patch: Partial<ProviderFormValues>) => void;
  onClose: () => void;
  onSubmit: () => void;
  saving: boolean;
  error: string | null;
  success: string | null;
};

export function ProviderFormModal({ form, onChange, onClose, onSubmit, saving, error, success }: Props) {
  return (
    <div className={styles.modalOverlay} onClick={() => !saving && onClose()}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>Nuevo proveedor</h3>
        <p className={styles.modalBody}>El proveedor se crea a nivel cliente y puede asignarse a cualquier consorcio.</p>
        <div className={styles.providerFormGrid}>
          <div className={styles.formField}>
            <label>Razón social *</label>
            <input className={styles.formInput} value={form.canonicalName} onChange={(e) => onChange({ canonicalName: e.target.value })} placeholder="Nombre completo del proveedor" />
          </div>
          <div className={styles.formField}>
            <label>CUIT *</label>
            <input className={styles.formInput} value={form.cuit} onChange={(e) => onChange({ cuit: e.target.value })} placeholder="20-12345678-9" />
          </div>
          <div className={`${styles.formField} ${styles.formFieldFull}`}>
            <label>Alias (opcional)</label>
            <input className={styles.formInput} value={form.paymentAlias} onChange={(e) => onChange({ paymentAlias: e.target.value })} placeholder="Nombre corto o abreviación" />
          </div>
        </div>
        {error && <p className={styles.errorMsg}>{error}</p>}
        {success && <p className={styles.infoMsg}>{success}</p>}
        <div className={styles.modalActions}>
          <button type="button" className={styles.ghostBtn} onClick={onClose} disabled={saving}>Cerrar</button>
          <button type="button" className={styles.providerBtn} onClick={onSubmit} disabled={saving}>
            {saving ? "Guardando..." : "Crear proveedor"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Correr el test del componente para verlo pasar**

Run: `npx vitest run src/app/admin/consortiums/components/ProviderFormModal.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 9: Cablear en `page.tsx`**

1. Borrar el estado y handler del proveedor: `showProviderModal`/`setShowProviderModal` (518), `providerForm`/`setProviderForm` (519), `providerError` (521), `providerSuccess` (522), `savingProvider`/`runProvider` (520), y `handleSaveProvider` (1210-1224).
2. Agregar el hook (el `onCreated` reemplaza el `setProviders(...)` original):

```tsx
const provider = useProviderForm((p) => setProviders((prev) => [...prev, p]));
```

3. Imports al tope:

```tsx
import { useProviderForm } from "./hooks/useProviderForm";
import { ProviderFormModal } from "./components/ProviderFormModal";
```

4. Reemplazar el botón de apertura (línea ~1432) por `onClick={provider.open}` (conservar icono/label).
5. Reemplazar el bloque JSX del modal (2223-2252) por:

```tsx
{provider.isOpen && (
  <ProviderFormModal
    form={provider.form}
    onChange={provider.setField}
    onClose={provider.close}
    onSubmit={provider.submit}
    saving={provider.saving}
    error={provider.error}
    success={provider.success}
  />
)}
```

- [ ] **Step 10: Verificar todo**

Run:
```bash
npm run typecheck
npm run lint
npx vitest run
npm run build:jobs
```
Expected: 0 errores; todos los tests verdes.

Smoke visual: `npm run dev` → botón "Nuevo proveedor": abre, valida faltantes, crea uno de prueba (queda disponible en los selectores de proveedor), y el aviso de reencolado aparece si corresponde.

- [ ] **Step 11: Commit (owner)**

```bash
git add src/app/admin/consortiums/hooks/useProviderForm.ts src/app/admin/consortiums/hooks/useProviderForm.test.tsx src/app/admin/consortiums/components/ProviderFormModal.tsx src/app/admin/consortiums/components/ProviderFormModal.test.tsx src/app/admin/consortiums/page.tsx
git commit -m "refactor(consortiums): extraer modal Crear Proveedor a hook + componente con tests"
```

---

## Task 7: Mover `PagosView` a su propio archivo (mudanza + test)

**Files:**
- Create: `src/app/admin/consortiums/components/PagosView.tsx`
- Create: `src/app/admin/consortiums/components/PagosView.test.tsx`
- Modify: `src/app/admin/consortiums/page.tsx`

`PagosView` (page.tsx 2668-3105, 438 líneas) **ya es un componente con props** (`PagosViewProps`) y estado propio. Depende solo de: `styles`, `useState`, `useAsyncAction`, `AsyncButton`, los helpers de formato (`formatAmount`, `formatAmountPlain`, `formatDate`, `parseAmountInput`, `todayInputDate`), y el tipo `Invoice`. Es una mudanza casi mecánica.

- [ ] **Step 1: Crear `components/PagosView.tsx` con la mudanza**

Cortar de `page.tsx` las interfaces `PendingPaymentInput` (2668-2673) y `PagosViewProps` (2675-2681) y la función `PagosView` (2683-3105) completas, pegarlas en el nuevo archivo con esta cabecera de imports, y exportar `PagosView` (agregar `export` a la función):

```tsx
// src/app/admin/consortiums/components/PagosView.tsx
"use client";
import { useState } from "react";
import styles from "../page.module.css";
import { AsyncButton } from "@/components/AsyncButton";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { formatAmount, formatAmountPlain, formatDate, parseAmountInput, todayInputDate } from "../lib/format";
import type { Invoice } from "../lib/types";

interface PendingPaymentInput {
  paymentDate: string;
  amount: string;
  paymentMethod: string;
  file: File | null;
}

interface PagosViewProps {
  invoices: Invoice[];
  onPagoGuardado: () => void;
  onPagar: (inv: Invoice) => void;
  onVerPagos: (inv: Invoice) => void;
  onEliminarUltimoPago: (invoiceId: string) => Promise<void>;
}

export function PagosView({ invoices, onPagoGuardado, onPagar, onVerPagos, onEliminarUltimoPago }: PagosViewProps) {
  // …cuerpo original de la función (page.tsx 2684-3105), copiado sin cambios de lógica…
}
```

> IMPORTANTE — es una **mudanza literal**: el cuerpo de `PagosView` (2684-3105) se copia sin editar ni una línea de lógica. Solo se agrega `export` a la firma y la cabecera de imports de arriba. Al pegar, verificar que dentro del cuerpo no queda ninguna referencia a algo que vivía en el scope de `page.tsx` — no debería, porque ya era una función top-level (solo usa props + helpers de módulo, todos ahora importados).

- [ ] **Step 2: Verificar que compila la mudanza**

Run: `npm run typecheck`
Expected: si hay algún identificador no importado (p.ej. un helper olvidado), TS lo marca acá. Agregar el import faltante desde `../lib/format` o `../lib/types` según corresponda. Objetivo: 0 errores.

- [ ] **Step 3: Cablear el import en `page.tsx`**

Donde estaban las definiciones, ahora `page.tsx` solo importa el componente (el uso `<PagosView ... />` en la solapa Pagos no cambia):

```tsx
import { PagosView } from "./components/PagosView";
```

- [ ] **Step 4: Escribir el test `PagosView.test.tsx`**

```tsx
// src/app/admin/consortiums/components/PagosView.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PagosView } from "./PagosView";
import type { Invoice } from "../lib/types";

const baseInvoice = (over: Partial<Invoice>): Invoice => ({
  id: "i1", boletaNumber: "0001", provider: "EDESUR", providerTaxId: "30-65511651-2",
  detail: null, observation: null, issueDate: null, dueDate: null, amount: 1000,
  isDuplicate: false, isManual: false, sourceFileUrl: null, tipoGasto: "ORDINARIO",
  tipoComprobante: null, createdAt: "2026-07-01T00:00:00.000Z", coeficienteRef: null,
  rubroRef: null, isPaid: false, remainingBalance: null, lspServiceId: null, ...over,
});

const noop = { onPagoGuardado: vi.fn(), onPagar: vi.fn(), onVerPagos: vi.fn(), onEliminarUltimoPago: vi.fn() };

describe("PagosView", () => {
  it("con boletas: muestra métricas y la boleta no duplicada", () => {
    render(<PagosView invoices={[baseInvoice({ id: "i1", provider: "EDESUR" })]} {...noop} />);
    expect(screen.getByText("Pagos registrados")).toBeInTheDocument();
    expect(screen.getByText("PROVEEDOR")).toBeInTheDocument();
    expect(screen.getByText("EDESUR")).toBeInTheDocument();
  });
  it("filtra las boletas duplicadas", () => {
    render(<PagosView invoices={[baseInvoice({ id: "i2", provider: "AYSA-DUP", isDuplicate: true })]} {...noop} />);
    expect(screen.queryByText("AYSA-DUP")).not.toBeInTheDocument();
  });
  it("sin boletas: muestra el empty-state", () => {
    render(<PagosView invoices={[]} {...noop} />);
    expect(screen.getByText("No hay boletas para este período.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Correr el test para verlo pasar**

Run: `npx vitest run src/app/admin/consortiums/components/PagosView.test.tsx`
Expected: PASS (3 tests). Si alguna aserción de texto no coincide exactamente con el JSX real (p.ej. el label del empty-state o de una métrica), ajustar la aserción al texto que renderiza el componente — la mudanza no cambia el markup, así que el texto es el del original.

- [ ] **Step 6: Verificar todo**

Run:
```bash
npm run typecheck
npm run lint
npx vitest run
npm run build:jobs
```
Expected: 0 errores; toda la suite verde.

Smoke visual: `npm run dev` → abrir un consorcio → solapa **Pagos**: la tabla, el buscador, cargar un pago pendiente y guardarlo (dispara `onPagoGuardado`), y "Ver pagos"/"Pagar"/"Eliminar último pago" funcionan igual que antes.

- [ ] **Step 7: Commit (owner)**

```bash
git add src/app/admin/consortiums/components/PagosView.tsx src/app/admin/consortiums/components/PagosView.test.tsx src/app/admin/consortiums/page.tsx
git commit -m "refactor(consortiums): mover PagosView a components/ con test"
```

---

## Task 8: Documentación (regla obligatoria del proyecto)

**Files:**
- Modify: `docs/progreso.md`
- Modify: `docs/decisiones.md`
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: `docs/progreso.md`** — actualizar la sección "Análisis de refactor (2026-07-15)" o agregar una nueva "Refactor consortiums/page.tsx — Fase 2, Tanda 1 (2026-07-16)": tanda 1 completa (lib/ + 2 modales + PagosView + infra jsdom), `page.tsx` bajó ~600-700 líneas, red de tests tier 0/1/2 sobre las piezas extraídas; pendiente Tanda 2 (useConsortiumDetail, useObligations, modal Cerrar período).

- [ ] **Step 2: `docs/decisiones.md`** — dos entradas con fecha 2026-07-16: (a) arquitectura de hooks por dominio + verificación por tiers de test (con alternativas descartadas: Context central, useReducer); (b) montaje de infra de tests de UI (jsdom + testing-library, `test.projects`, split por extensión `.test.ts`/`.test.tsx`, jsdom vs happy-dom).

- [ ] **Step 3: `CHANGELOG.md`** — entrada 2026-07-16 con los highlights de la tanda 1.

- [ ] **Step 4: `CLAUDE.md`** — en Convenciones de código → Tests: documentar los dos proyectos de Vitest y la convención de extensión (`*.test.ts` node / `*.test.tsx` jsdom para UI).

- [ ] **Step 5: Commit (owner)**

```bash
git add docs/progreso.md docs/decisiones.md CHANGELOG.md CLAUDE.md
git commit -m "docs: registrar tanda 1 del refactor de consortiums/page + infra de tests UI"
```

---

## Verificación final de la tanda 1

Al terminar las 8 tareas:
```bash
npm run typecheck   # 0 errores
npm run lint        # 0 errores nuevos
npx vitest run      # 299 previos + 40 nuevos (node: format 13 + match 9; jsdom: infra 1 + useConsortiumForm 4 + ConsortiumFormModal 4 + useProviderForm 3 + ProviderFormModal 3 + PagosView 3), todos verdes
npm run build:jobs  # OK
npm run build       # OK (valida el árbol de rutas/SSR)
```
Smoke visual integral en `/admin/consortiums`: grilla, abrir/crear consorcio, abrir/crear proveedor, solapa Pagos completa. `page.tsx` debe haber bajado ~600-700 líneas y `lib/` + `hooks/` + `components/` estar poblados.
