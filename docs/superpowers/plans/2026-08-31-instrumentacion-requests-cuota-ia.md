# Instrumentación de requests y cuota de IA — Plan de implementación

> **Nota del proyecto:** este plan **no lleva pasos de commit**. En este repo Claude nunca commitea
> ni hace staging: el owner maneja los commits con GitLens. Cada tarea termina en "verificar", no en
> "commitear".

**Goal:** registrar, por cada archivo procesado, cuántas requests HTTP se le hicieron a la IA (abiertas por modelo), si se gastó visión, y con qué resultado terminó — para poder medir el consumo contra el techo de ~60 requests/día del free tier y atribuir el 30% de overhead de tokens.

**Architecture:** un contador puro por boleta que incrementa **quien hace la llamada HTTP** (nunca el orquestador), viajando como parámetro opcional por la cadena de extractores; y un seam `onOutcome` en el `finally` de `runPipeline` — el punto único por el que salen los 8 caminos — que el worker conecta a cinco columnas nuevas de `ProcessingJob`.

**Tech Stack:** TypeScript, Prisma/PostgreSQL, Vitest (proyecto `node` para `.test.ts`).

**Spec:** `docs/superpowers/specs/2026-08-31-instrumentacion-requests-cuota-ia-design.md`

---

### Task 1: `AiRequestCounter`

**Files:**
- Create: `src/lib/aiRequestCounter.ts`
- Test: `src/lib/aiRequestCounter.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
import { describe, expect, it } from "vitest";
import { AiRequestCounter } from "./aiRequestCounter";

describe("AiRequestCounter", () => {
  it("arranca vacío", () => {
    const c = new AiRequestCounter();
    expect(c.total()).toBe(0);
    expect(c.snapshot()).toEqual({});
  });

  it("cuenta por provider:model", () => {
    const c = new AiRequestCounter();
    c.record("gemini", "gemini-2.5-flash-lite");
    c.record("gemini", "gemini-2.5-flash-lite");
    c.record("gemini", "gemini-2.5-flash");
    expect(c.total()).toBe(3);
    expect(c.snapshot()).toEqual({
      "gemini:gemini-2.5-flash-lite": 2,
      "gemini:gemini-2.5-flash": 1,
    });
  });

  it("separa proveedores distintos", () => {
    const c = new AiRequestCounter();
    c.record("gemini", "gemini-2.5-flash-lite");
    c.record("cerebras", "gpt-oss-120b");
    expect(c.total()).toBe(2);
    expect(c.snapshot()["cerebras:gpt-oss-120b"]).toBe(1);
  });

  it("usa 'unknown' cuando no hay modelo", () => {
    const c = new AiRequestCounter();
    c.record("openai", "");
    expect(c.snapshot()).toEqual({ "openai:unknown": 1 });
  });

  it("snapshot devuelve una copia, no la referencia interna", () => {
    const c = new AiRequestCounter();
    c.record("gemini", "x");
    const snap = c.snapshot();
    snap["gemini:x"] = 99;
    expect(c.snapshot()["gemini:x"]).toBe(1);
  });
});
```

- [ ] **Step 2: Correr el test y verlo fallar**

Run: `npx vitest run src/lib/aiRequestCounter.test.ts`
Expected: FAIL — `Failed to resolve import "./aiRequestCounter"`

- [ ] **Step 3: Implementar**

```ts
/**
 * Cuenta las requests HTTP que se le hacen a la IA mientras se procesa UNA boleta.
 *
 * La cuota del free tier de Gemini se gasta por request y **por modelo** (~20/día
 * cada uno), así que un total agregado no alcanza: hay que saber cuál de los
 * baldes se vació. El barrido de modelos de `GeminiExtractorService` puede gastar
 * hasta 6 requests en un solo "intento" de la cadena.
 *
 * **Regla: incrementa quien hace la llamada HTTP, nunca el orquestador.** Si
 * contara `AiExtractionChain.run`, un barrido de 3 modelos contaría 1.
 */
export class AiRequestCounter {
  private readonly counts = new Map<string, number>();

  record(provider: string, model: string): void {
    const key = `${provider}:${model || "unknown"}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  total(): number {
    let sum = 0;
    for (const n of this.counts.values()) sum += n;
    return sum;
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }
}
```

- [ ] **Step 4: Correr el test y verlo pasar**

Run: `npx vitest run src/lib/aiRequestCounter.test.ts`
Expected: PASS (5 tests)

---

### Task 2: Propagar el contador por la cadena y los cuatro extractores

**Files:**
- Modify: `src/services/aiExtraction.ts` (interfaz `AiExtractor`, método `run`)
- Modify: `src/services/geminiExtractor.service.ts` (`extractStructuredData`, `extractPartiesFromImage`, `extractStructuredDataFromImage`)
- Modify: `src/services/openAICompatibleExtractor.service.ts:65`
- Modify: `src/services/aiExtractor.service.ts:28`
- Modify: `src/services/claudeExtractor.service.ts:27`
- Test: `src/services/geminiExtractor.service.test.ts`

- [ ] **Step 1: Escribir el test que falla (el barrido de 3 modelos cuenta 3)**

Agregar a `geminiExtractor.service.test.ts`, siguiendo el patrón de los tests que ya
usan el `sleep` inyectable y `resetWorkingModel`:

```ts
it("cuenta una request por cada modelo del barrido", async () => {
  GeminiExtractorService.resetWorkingModel();
  const counter = new AiRequestCounter();
  // FakeGemini con los 3 modelos fallando (mismo patrón que los tests de 503 que ya existen)
  const service = new FakeGemini({ apiKey: "k" }, /* respuestas que fallan */);

  await expect(service.extractStructuredData("texto", counter)).rejects.toThrow();

  expect(counter.total()).toBe(3);
  expect(Object.keys(counter.snapshot())).toHaveLength(3);
});

it("cuenta una sola request cuando el primer modelo responde", async () => {
  GeminiExtractorService.resetWorkingModel();
  const counter = new AiRequestCounter();
  const service = new FakeGemini({ apiKey: "k" }, /* respuesta OK */);

  await service.extractStructuredData("texto", counter);

  expect(counter.total()).toBe(1);
});
```

> El helper es **`FakeGemini`** (`geminiExtractor.service.test.ts:36`), la subclase que
> ya se usa para stubear `getModel` — que es `protected` justamente para esto. Copiar
> la forma de construirlo de los tests de 503/429 que ya están en el archivo; no crear
> fakes nuevos.

- [ ] **Step 2: Correr y ver fallar**

Run: `npx vitest run src/services/geminiExtractor.service.test.ts`
Expected: FAIL — `extractStructuredData` no acepta el segundo parámetro / `counter.total()` es 0

- [ ] **Step 3: Cambiar la interfaz en `aiExtraction.ts`**

```ts
import type { AiRequestCounter } from "@/lib/aiRequestCounter";

export interface AiExtractor {
  readonly provider: AiProvider;
  extractStructuredData(text: string, counter?: AiRequestCounter): Promise<ExtractedDocumentData>;
  getLastUsage(): AiUsageMetrics | null;
}
```

Y en `AiExtractionChain.run`, propagar sin contar nada por su cuenta:

```ts
  async run(
    text: string,
    onAttempt?: AiAttemptCallback,
    counter?: AiRequestCounter
  ): Promise<AiExtractionResult | null> {
    for (const extractor of this.extractors) {
      try {
        const data = await extractor.extractStructuredData(text, counter);
        onAttempt?.(extractor.provider, true);
        return { data, usage: extractor.getLastUsage(), provider: extractor.provider };
      } catch (error) {
        onAttempt?.(
          extractor.provider,
          false,
          error instanceof Error ? error.message : "Unknown error",
          isRateLimitError(error)
        );
      }
    }
    return null;
  }
```

- [ ] **Step 4: Registrar en Gemini — una vez por modelo probado**

En `extractStructuredData`, dentro del `for (const modelName of this.buildModelCandidates())`,
**antes** de la llamada (para que un throw también quede contado):

```ts
  async extractStructuredData(text: string, counter?: AiRequestCounter): Promise<ExtractedDocumentData> {
    // ...
    for (const modelName of this.buildModelCandidates()) {
      try {
        counter?.record("gemini", modelName);
        const result = await this.generateWithTransientRetry(modelName, {
```

Hacer lo mismo en `extractPartiesFromImage` y `extractStructuredDataFromImage`, que
tienen el mismo bucle: agregar `counter?: AiRequestCounter` como último parámetro y
`counter?.record("gemini", modelName);` al principio del `try`.

> `generateWithTransientRetry` reintenta el MISMO modelo una vez ante un 503. Ese
> reintento **es** otra request: agregar `counter?.record("gemini", modelName)`
> también en la rama del reintento (`geminiExtractor.service.ts:165`), pasándole el
> counter al método.

- [ ] **Step 5: Registrar en los otros tres extractores**

Cada uno hace exactamente una llamada por invocación. En los tres, agregar el
parámetro y una línea antes del request:

```ts
// openAICompatibleExtractor.service.ts
async extractStructuredData(text: string, counter?: AiRequestCounter): Promise<ExtractedDocumentData> {
  counter?.record(this.provider, this.model);
  // ...resto igual
```

```ts
// aiExtractor.service.ts
async extractStructuredData(text: string, counter?: AiRequestCounter): Promise<ExtractedDocumentData> {
  counter?.record("openai", this.model);
  // ...resto igual
```

```ts
// claudeExtractor.service.ts
async extractStructuredData(text: string, counter?: AiRequestCounter): Promise<ExtractedDocumentData> {
  counter?.record("anthropic", this.model);
  // ...resto igual
```

- [ ] **Step 6: Correr y ver pasar**

Run: `npx vitest run src/services/`
Expected: PASS — incluidos los tests viejos, porque el parámetro es opcional y los
`FakeExtractor` de `aiExtraction.test.ts` no necesitan cambios.

---

### Task 3: Contador y `usedVision` en el `PipelineContext`

**Files:**
- Modify: `src/jobs/pipeline/context.ts` (interfaz + factory)
- Modify: `src/jobs/processPendingDocuments.job.ts` (`aiExtractStep`, `runVisionExtraction`, `assignmentStep`)
- Test: `src/jobs/processPendingDocuments.job.test.ts`

- [ ] **Step 1: Agregar los campos al contexto**

En `PipelineContext` (después de `visionResolved`):

```ts
  /** Requests HTTP a la IA de ESTA boleta, abiertas por proveedor:modelo. */
  aiRequests: AiRequestCounter;
  /** `true` si se gastó Gemini Vision (membrete, imagen o PDF escaneado). */
  usedVision: boolean;
```

Con el import correspondiente, y en `createPipelineContext`:

```ts
    aiRequests: new AiRequestCounter(),
    usedVision: false,
```

- [ ] **Step 2: Pasar el contador donde se llama a la IA**

En `aiExtractStep`, la llamada a la cadena pasa a:

```ts
const aiResult = await aiChain.run(promptText, onAttempt, ctx.aiRequests);
```

> El nombre exacto de la variable del texto y del callback los define el código
> existente en `aiExtractStep`; sólo se agrega el tercer argumento.

En `runVisionExtraction` y en la instancia de visión de `assignmentStep`
(`processPendingDocuments.job.ts:1169`), pasar `ctx.aiRequests` a la llamada y
marcar la bandera:

```ts
ctx.usedVision = true;
const visual = await visualExtractor.extractPartiesFromImage(
  membretePng,
  assignment.canonicalConsortium ?? extracted.consortium ?? "",
  ctx.aiRequests
);
```

- [ ] **Step 3: Verificar que no rompió nada**

Run: `npx vitest run src/jobs/processPendingDocuments.job.test.ts`
Expected: PASS (los tests de caracterización siguen verdes)

---

### Task 4: Seam `onOutcome`

**Files:**
- Modify: `src/jobs/processPendingDocuments.job.ts` (tipo `JobOutcome`, `ProcessingContext`, `createProcessingContext`, `processSingleDriveFileJob`)
- Modify: `src/jobs/pipeline/runner.ts` (`finally`)
- Test: `src/jobs/processPendingDocuments.job.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
it("emite onOutcome con las requests contadas en el camino ok", async () => {
  const ctx = makeContext();
  const onOutcome = vi.fn();
  (ctx as unknown as { onOutcome: unknown }).onOutcome = onOutcome;

  await processDriveFile(file, ctx, summary);

  expect(onOutcome).toHaveBeenCalledTimes(1);
  expect(onOutcome.mock.calls[0][0]).toMatchObject({ outcome: "ok", usedVision: false });
});

it("emite onOutcome también cuando la boleta queda sin asignar", async () => {
  const ctx = makeContext(/* config que deja la boleta sin proveedor */);
  const onOutcome = vi.fn();
  (ctx as unknown as { onOutcome: unknown }).onOutcome = onOutcome;

  await processDriveFile(file, ctx, summary);

  expect(onOutcome.mock.calls[0][0]).toMatchObject({ outcome: "unassigned" });
});

it("sin colector, el pipeline se comporta igual", async () => {
  const ctx = makeContext();                  // sin onOutcome
  await expect(processDriveFile(file, ctx, summary)).resolves.not.toThrow();
});
```

> El helper es **`makeContext`** (`processPendingDocuments.job.test.ts:71`) y el seam se
> inyecta con el cast `(ctx as unknown as { onOutcome: unknown }).onOutcome = fn`, que es
> exactamente cómo están escritos los tres tests de `onDiagnostics` (líneas 695-719).
> Copiar ese molde, incluido cómo arman `file` y `summary`.

- [ ] **Step 2: Correr y ver fallar**

Run: `npx vitest run src/jobs/processPendingDocuments.job.test.ts`
Expected: FAIL — `onOutcome` no existe en el tipo del contexto

- [ ] **Step 3: Definir el tipo y el punto de inyección**

En `processPendingDocuments.job.ts`, al lado de `BoletaDiagnostics`:

```ts
/**
 * Resultado de UNA boleta, para persistir métricas de consumo. Se emite en todos
 * los caminos de salida. A diferencia de `BoletaDiagnostics` — que sólo existe en
 * la corrida selectiva — este colector lo inyecta el worker SIEMPRE.
 */
export interface JobOutcome {
  fileId: string;
  outcome: string;
  reasonCategory: string | null;
  aiRequests: number;
  aiRequestsByModel: Record<string, number>;
  usedVision: boolean;
}
```

Agregarlo a `ProcessingContext` (junto a `onDiagnostics`, línea 103):

```ts
  onOutcome?: (payload: JobOutcome) => void;
```

Y propagarlo por las dos firmas que ya llevan `onDiagnostics`:

```ts
async function createProcessingContext(
  config: ProcessJobConfig,
  mapping: SheetsRowMapping,
  onDiagnostics?: (payload: BoletaDiagnostics) => void,
  onOutcome?: (payload: JobOutcome) => void
): Promise<ProcessingContext> {
```

```ts
export async function processSingleDriveFileJob(
  config: ProcessJobConfig,
  file: ProcessDriveFileInput,
  mapping?: SheetsRowMapping,
  onDiagnostics?: (payload: BoletaDiagnostics) => void,
  onOutcome?: (payload: JobOutcome) => void
): Promise<ProcessJobSummary> {
```

Pasando `onOutcome` en la llamada a `createProcessingContext` y agregándolo al
objeto que devuelve (donde ya se devuelve `onDiagnostics`).

- [ ] **Step 4: Emitir en el `finally` del runner**

En `runner.ts`, después del `deps.onDiagnostics?.({...})`:

```ts
    // Métrica de consumo: se emite SIEMPRE (el colector lo inyecta el worker), a
    // diferencia de onDiagnostics que sólo existe en la corrida selectiva.
    deps.onOutcome?.({
      fileId: file.id,
      outcome: m.result,
      reasonCategory: m.reason,
      aiRequests: ctx.aiRequests.total(),
      aiRequestsByModel: ctx.aiRequests.snapshot(),
      usedVision: ctx.usedVision,
    });
```

- [ ] **Step 5: Correr y ver pasar**

Run: `npx vitest run src/jobs/processPendingDocuments.job.test.ts`
Expected: PASS

---

### Task 5: Migración y schema

**Files:**
- Create: `prisma/migrations/20260831000000_processing_job_metrics/migration.sql`
- Modify: `prisma/schema.prisma` (modelo `ProcessingJob`)

- [ ] **Step 1: Escribir la migración**

```sql
-- Métricas de consumo de IA por archivo procesado (2026-08-31).
-- Todas nullable: las filas viejas no las tienen, y un job que muere antes de
-- llegar al pipeline nunca las escribe.
ALTER TABLE "ProcessingJob"
  ADD COLUMN "outcome"        TEXT,
  ADD COLUMN "reasonCategory" TEXT,
  ADD COLUMN "aiRequests"     INTEGER,
  ADD COLUMN "usedVision"     BOOLEAN,
  ADD COLUMN "aiRequestsJson" JSONB;
```

- [ ] **Step 2: Reflejarlo en el schema**

En `model ProcessingJob`, después de `diagnosticsJson`:

```prisma
  /// Cómo terminó la boleta: ok / unassigned / duplicate / not_boleta /
  /// no_amount / no_period / rate_limited / failed.
  outcome         String?
  /// Sale de `m.reason`. En `unassigned` es la reasonCategory del assignment
  /// (las 4 de CUIT incluidas); en el resto, el motivo del corte.
  reasonCategory  String?
  /// Requests HTTP reales a la IA, con barrido de modelos y visión incluidos.
  aiRequests      Int?
  /// Si se gastó Gemini Vision en esta boleta.
  usedVision      Boolean?
  /// Requests abiertas por "provider:model" — la cuota free es por modelo.
  aiRequestsJson  Json?
```

- [ ] **Step 3: Verificar que el schema es válido**

Run: `npx prisma validate`
Expected: `The schema at prisma\schema.prisma is valid 🚀`

> **No correr `prisma migrate deploy` ni `prisma generate`.** Los ejecuta el owner
> (el `.dll` del cliente queda bloqueado en Windows si hay procesos vivos). Hasta
> que los corra, el tipo generado no tiene las columnas nuevas y la Task 6 no
> compila: es esperado.

---

### Task 6: El worker persiste el outcome

**Files:**
- Modify: `src/jobs/jobWorkerMain.ts:190-225` (colector + escritura)

- [ ] **Step 1: Capturar el outcome**

Al lado del colector de diagnósticos que ya existe:

```ts
  let outcome: JobOutcome | null = null;
  const onOutcome = (payload: JobOutcome) => { outcome = payload; };
```

Y pasarlo como quinto argumento de `processSingleDriveFileJob`, después de
`onDiagnostics`.

- [ ] **Step 2: Escribirlo antes de cerrar el job**

Junto al bloque que ya guarda los diagnósticos antes de `finalizeJob`:

```ts
  // Métricas de consumo. Best-effort: si falla, se loguea y el job se cierra
  // igual — una métrica nunca puede hacer fallar el procesamiento de una boleta.
  if (outcome) {
    try {
      await getPrismaClient().processingJob.update({
        where: { id: job.id },
        data: {
          outcome: outcome.outcome,
          reasonCategory: outcome.reasonCategory,
          aiRequests: outcome.aiRequests,
          usedVision: outcome.usedVision,
          aiRequestsJson: outcome.aiRequestsByModel,
        },
      });
    } catch (error) {
      workerLog.dbRetry("metrics", 1, errMessage(error));
    }
  }
```

- [ ] **Step 3: Verificar**

Run: `npm run typecheck`
Expected: 0 errores — **después** de que el owner corra `prisma generate`. Si todavía
no lo corrió, el único error aceptable es que `outcome`/`aiRequests` no existen en
`ProcessingJobUpdateInput`.

> **Desvío del spec, consciente.** El spec (§5) pedía un test de que "el fallo al
> escribir la métrica no rompe el job". **No hay suite de tests para `jobWorkerMain`**:
> el único test de `src/jobs/` es `processPendingDocuments.job.test.ts`. Montar una
> requiere mockear Prisma, el claim de jobs y el ciclo del worker — es un proyecto
> aparte, no un paso de esta tarea. La garantía queda en el `try/catch` explícito del
> Step 2, que es la misma forma en que el worker ya trata el guardado de diagnósticos
> (que tampoco tiene test). Si más adelante se arma la suite del worker, este es el
> primer caso que debería cubrir.

---

### Task 7: Consultas

**Files:**
- Create: `scripts/metrics-cuota.sql`

- [ ] **Step 1: Escribir las tres consultas**

```sql
-- 1) Requests por día contra el techo de ~60 (3 modelos × ~20 del free tier).
SELECT "createdAt"::date            AS dia,
       count(*)                     AS archivos,
       sum("aiRequests")            AS requests,
       count(*) FILTER (WHERE "usedVision") AS con_vision
FROM "ProcessingJob"
WHERE "aiRequests" IS NOT NULL
GROUP BY 1 ORDER BY 1 DESC;

-- 1b) Abierto por modelo: cuál de los baldes se vacía primero.
SELECT "createdAt"::date AS dia, kv.key AS modelo, sum(kv.value::int) AS requests
FROM "ProcessingJob" pj, jsonb_each_text(pj."aiRequestsJson") AS kv
WHERE pj."aiRequestsJson" IS NOT NULL
GROUP BY 1, 2 ORDER BY 1 DESC, 3 DESC;

-- 2) Rebotes por categoría: "falta el alta" vs "el papel no lo trae".
SELECT "reasonCategory", count(*) AS boletas, sum("aiRequests") AS requests
FROM "ProcessingJob"
WHERE outcome = 'unassigned'
GROUP BY 1 ORDER BY 2 DESC;

-- 3) A dónde se va el gasto: requests por resultado final.
SELECT outcome,
       count(*)                        AS archivos,
       sum("aiRequests")               AS requests,
       round(avg("aiRequests"), 2)     AS requests_prom
FROM "ProcessingJob"
WHERE outcome IS NOT NULL
GROUP BY 1 ORDER BY 3 DESC NULLS LAST;
```

> Control de sanidad: los `duplicate` tienen que dar `aiRequests = 0`, porque
> `dedupHashStep` corre antes de la IA. Si dan más que 0, el contador está
> registrando de más.

---

### Task 8: Documentación y verificación final

**Files:**
- Modify: `docs/progreso.md`, `docs/decisiones.md`, `CHANGELOG.md`, `CLAUDE.md`

- [ ] **Step 1: Verificación completa**

Run: `npm run typecheck`
Run: `npx vitest run`
Run: `npm run lint`
Run: `npm run build:jobs`
Expected: 0 errores de typecheck, todos los tests verdes, 0 errores de lint.

- [ ] **Step 2: Documentar**

- `docs/decisiones.md`: entrada del 2026-08-31 con el problema (no se registraba ni
  una request, el 30% de overhead no era atribuible), la decisión (columnas en
  `ProcessingJob` + contador donde se hace la llamada) y las alternativas
  descartadas (contador estático — con el precedente del bug de `workingModelName`;
  tabla de eventos; parsear logs).
- `docs/progreso.md`: estado de la feature + que la migración la aplica el owner.
- `CHANGELOG.md`: entrada en `[Unreleased]`.
- `CLAUDE.md`: las cinco columnas nuevas en el bloque de `ProcessingJob` del schema.

- [ ] **Step 3: Avisar al owner**

Avisar que hay **migración pendiente** (`20260831000000_processing_job_metrics`) y
que hasta que corra `npx prisma migrate deploy` + `npx prisma generate` el worker no
puede escribir las columnas.
