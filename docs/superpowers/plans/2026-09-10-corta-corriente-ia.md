# Corta-corriente de IA — Plan de implementación

> **Para quien lo ejecute:** los pasos usan checkbox (`- [ ]`) para seguimiento.
> **Este plan NO incluye pasos de commit**: en este repo los commits los hace el owner (regla de `CLAUDE.md`).

**Goal:** cuando los tres proveedores de IA fallan por infraestructura, cortar la cadena 30 minutos por cliente y devolver las boletas a Pendientes, en vez de que cada archivo redescubra la caída pagando 5-7 requests y termine en Revisión con el cartel `SIN MONTO`.

**Architecture:** un `AiCircuitBreaker` con estado en memoria del proceso (`Map<clientId, {until, reason}>`), reloj inyectable. Se consulta en un paso nuevo del pipeline (`circuitBreakerGate`, entre `dedupHash` y `textExtract`) y se dispara desde `aiExtractStep` cuando **todas** las fallas de la cadena son de infraestructura. La clasificación de "infraestructura" la calcula la cadena sobre el objeto de error y la propaga por el callback — el pipeline nunca parsea mensajes.

**Tech Stack:** TypeScript, Vitest (proyecto `node`, archivos `.test.ts`), pipeline Pipe & Filter existente.

**Spec:** `docs/superpowers/specs/2026-09-10-corta-corriente-ia-design.md`

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `src/lib/aiErrors.ts` (modificar) | Sumar `isProviderDownError`. Ya vive acá `isRateLimitError` e `isTransientServerError` |
| `src/lib/aiErrors.test.ts` (modificar) | Tests de la clasificación nueva |
| `src/lib/aiCircuitBreaker.ts` (crear) | El breaker. Sin dependencias del pipeline ni del logger: lógica pura y testeable |
| `src/lib/aiCircuitBreaker.test.ts` (crear) | Tests del breaker con reloj inyectado |
| `src/services/aiExtraction.ts` (modificar) | La cadena calcula `infrastructure` sobre el objeto de error y lo pasa por el callback |
| `src/jobs/processPendingDocuments.job.ts` (modificar) | `circuitBreakerGate` nuevo, breaker en `ProcessingContext`, guard de `aiExtractStep` |
| `src/jobs/processPendingDocuments.job.test.ts` (modificar) | Tests de los caminos nuevos |

---

## Task 0: Línea de base

**Files:** ninguno (sólo verificación)

- [ ] **Step 1: Correr la red de caracterización ANTES de tocar nada**

Run:
```bash
npx vitest run src/jobs/processPendingDocuments.job.test.ts
```

Expected: PASS. Anotar el número de tests. Si algo falla acá, **parar**: el problema es preexistente y hay que resolverlo antes.

- [ ] **Step 2: Correr la suite completa y anotar el total**

Run:
```bash
npx vitest run
```

Expected: PASS. Anotar el total de tests (es el número contra el que se compara al final).

---

## Task 1: `isProviderDownError`

**Files:**
- Modify: `src/lib/aiErrors.ts`
- Test: `src/lib/aiErrors.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al final de `src/lib/aiErrors.test.ts` (dentro del `describe` de nivel superior si existe, o como bloque nuevo):

```ts
describe("isProviderDownError", () => {
  it("reconoce el 402 de Cerebras por texto", () => {
    expect(isProviderDownError(new Error("402 status code (no body)"))).toBe(true);
  });

  it("reconoce el 402 por status del SDK", () => {
    expect(isProviderDownError({ status: 402 })).toBe(true);
  });

  it("reconoce 'no credits remaining' de OpenAI", () => {
    expect(
      isProviderDownError(new Error("429 You have no credits remaining. Add credits to continue"))
    ).toBe(true);
  });

  it("no confunde un 4020 con el codigo 402", () => {
    expect(isProviderDownError(new Error("importe 4020 pesos"))).toBe(false);
  });

  it("no marca un error de contenido", () => {
    expect(isProviderDownError(new Error("Unexpected token in JSON at position 0"))).toBe(false);
  });

  it("null y undefined no son proveedor caido", () => {
    expect(isProviderDownError(null)).toBe(false);
    expect(isProviderDownError(undefined)).toBe(false);
  });
});

describe("las tres clasificaciones no se pisan", () => {
  it("el 429 sigue siendo rate limit", () => {
    expect(isRateLimitError(new Error("429 Too Many Requests"))).toBe(true);
  });

  it("el 503 sigue siendo transitorio", () => {
    expect(isTransientServerError(new Error("503 Service Unavailable"))).toBe(true);
  });

  it("el 402 no es rate limit ni transitorio", () => {
    const err = new Error("402 status code (no body)");
    expect(isRateLimitError(err)).toBe(false);
    expect(isTransientServerError(err)).toBe(false);
  });
});
```

Ajustar el `import` del principio del archivo para incluir `isProviderDownError`.

- [ ] **Step 2: Correr y verificar que falla**

Run:
```bash
npx vitest run src/lib/aiErrors.test.ts
```

Expected: FAIL — `isProviderDownError is not a function` / error de TypeScript por el import.

- [ ] **Step 3: Implementar**

Agregar al final de `src/lib/aiErrors.ts`:

```ts
/**
 * Devuelve true si el proveedor **no está disponible para nosotros**: sin
 * crédito, sin plan, pago requerido (HTTP 402). Es distinto de la cuota agotada
 * (429, `isRateLimitError`) y de la caída transitoria (503,
 * `isTransientServerError`), y la diferencia importa:
 *
 * El guard de `aiExtractStep` exige que TODAS las fallas de la cadena sean de
 * infraestructura para devolver la boleta a Pendientes. Cerebras devolviendo
 * `402 status code (no body)` no matcheaba ninguna de las dos clasificaciones
 * anteriores, así que la condición nunca se cumplía y 23 boletas sanas fueron a
 * Revisión con el cartel SIN MONTO (medido, 2026-09-08/09).
 *
 * Se usa `\b402\b` por el mismo motivo que el 429 y el 503: no confundir un "4020".
 */
export function isProviderDownError(error: unknown): boolean {
  if (error === null || error === undefined) return false;

  if (typeof error === "object") {
    const e = error as { status?: unknown };
    if (e.status === 402) return true;
  }

  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();

  return (
    /\b402\b/.test(text) ||
    text.includes("no credits") ||
    text.includes("payment required")
  );
}

/**
 * ¿La falla es de INFRAESTRUCTURA (el proveedor no pudo atender) y no de
 * contenido (el documento rompió la extracción)?
 *
 * Es la unión de las tres clasificaciones. Fuente única: el pipeline y la cadena
 * la comparten para no reimplementar el criterio en dos lugares.
 */
export function isInfrastructureFailure(error: unknown): boolean {
  return isRateLimitError(error) || isTransientServerError(error) || isProviderDownError(error);
}
```

- [ ] **Step 4: Correr y verificar que pasa**

Run:
```bash
npx vitest run src/lib/aiErrors.test.ts
```

Expected: PASS.

---

## Task 2: `AiCircuitBreaker`

**Files:**
- Create: `src/lib/aiCircuitBreaker.ts`
- Test: `src/lib/aiCircuitBreaker.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

Crear `src/lib/aiCircuitBreaker.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { AiCircuitBreaker } from "@/lib/aiCircuitBreaker";

/** Reloj controlable: los tests no esperan tiempo real. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("AiCircuitBreaker", () => {
  it("arranca cerrado", () => {
    const breaker = new AiCircuitBreaker(fakeClock().now, 30 * 60 * 1000);
    expect(breaker.isOpen("client-1")).toBe(false);
  });

  it("queda abierto despues de trip", () => {
    const breaker = new AiCircuitBreaker(fakeClock().now, 30 * 60 * 1000);
    breaker.trip("client-1", "todos los proveedores caidos");
    expect(breaker.isOpen("client-1")).toBe(true);
  });

  it("conserva el motivo mientras esta abierto", () => {
    const breaker = new AiCircuitBreaker(fakeClock().now, 30 * 60 * 1000);
    breaker.trip("client-1", "todos los proveedores caidos");
    expect(breaker.reasonFor("client-1")).toBe("todos los proveedores caidos");
  });

  it("es por cliente: abrir uno no afecta al otro", () => {
    const breaker = new AiCircuitBreaker(fakeClock().now, 30 * 60 * 1000);
    breaker.trip("client-1", "caida");
    expect(breaker.isOpen("client-1")).toBe(true);
    expect(breaker.isOpen("client-2")).toBe(false);
  });

  it("sigue abierto justo antes de que venza el cooldown", () => {
    const clock = fakeClock();
    const breaker = new AiCircuitBreaker(clock.now, 30 * 60 * 1000);
    breaker.trip("client-1", "caida");
    clock.advance(30 * 60 * 1000 - 1);
    expect(breaker.isOpen("client-1")).toBe(true);
  });

  it("se cierra solo al vencer el cooldown", () => {
    const clock = fakeClock();
    const breaker = new AiCircuitBreaker(clock.now, 30 * 60 * 1000);
    breaker.trip("client-1", "caida");
    clock.advance(30 * 60 * 1000);
    expect(breaker.isOpen("client-1")).toBe(false);
    expect(breaker.reasonFor("client-1")).toBeNull();
  });

  it("un trip nuevo extiende el cooldown desde ese momento", () => {
    const clock = fakeClock();
    const breaker = new AiCircuitBreaker(clock.now, 1000);
    breaker.trip("client-1", "primera");
    clock.advance(900);
    breaker.trip("client-1", "segunda");
    clock.advance(200); // 1100 desde el primer trip, 200 desde el segundo
    expect(breaker.isOpen("client-1")).toBe(true);
    expect(breaker.reasonFor("client-1")).toBe("segunda");
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run:
```bash
npx vitest run src/lib/aiCircuitBreaker.test.ts
```

Expected: FAIL — no existe el módulo `@/lib/aiCircuitBreaker`.

- [ ] **Step 3: Implementar**

Crear `src/lib/aiCircuitBreaker.ts`:

```ts
/**
 * Corta-corriente de la cadena de IA.
 *
 * Problema que resuelve (medido en producción, 2026-09-08/09): cuando los tres
 * proveedores están caídos, CADA archivo redescubre el hecho barriendo la cadena
 * entera. 23 archivos gastaron 134 requests para establecer 23 veces lo mismo, y
 * los 23 terminaron en Revisión con el cartel SIN MONTO.
 *
 * Al primer fallo total por infraestructura se abre el corte por `cooldownMs` y
 * las boletas siguientes vuelven a Pendientes sin gastar nada. Se re-sondea solo
 * al vencer el cooldown, porque la cuota de Gemini se recupera durante el día
 * (medido: cayó 09:10, volvió a contestar 15:17).
 *
 * **El estado es por cliente**: las API keys viven en `googleConfigJson` de cada
 * uno, así que un cliente que quema su cuota no debe cegar a otro.
 *
 * **El estado vive en memoria del proceso** y muere con el reinicio, igual que
 * `GeminiExtractorService.workingModelName`. Es deliberado: un worker que
 * arranca de nuevo debe volver a probar.
 *
 * El reloj se inyecta para que los tests no esperen tiempo real. El spec
 * `2026-08-24-gemini-tier-pago-cadena-y-modelos-design.md` había descartado meter
 * tiempo en el estado; acá se hace a propósito porque **no existe otra señal de
 * reset** (ver §8 del spec de este cambio).
 */

/** 30 minutos. */
export const DEFAULT_CIRCUIT_COOLDOWN_MS = 30 * 60 * 1000;

interface OpenCircuit {
  until: number;
  reason: string;
}

export class AiCircuitBreaker {
  private readonly open = new Map<string, OpenCircuit>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly cooldownMs: number = DEFAULT_CIRCUIT_COOLDOWN_MS
  ) {}

  /** ¿El corte está activo para este cliente? Cierra solo si venció el cooldown. */
  isOpen(clientId: string): boolean {
    return this.peek(clientId) !== null;
  }

  /** Motivo del corte mientras está abierto; `null` si está cerrado. */
  reasonFor(clientId: string): string | null {
    return this.peek(clientId)?.reason ?? null;
  }

  /** Abre el corte por `cooldownMs` a partir de ahora. Un trip nuevo lo extiende. */
  trip(clientId: string, reason: string): void {
    this.open.set(clientId, { until: this.now() + this.cooldownMs, reason });
  }

  /** Devuelve el corte vigente y lo limpia si ya venció. */
  private peek(clientId: string): OpenCircuit | null {
    const circuit = this.open.get(clientId);
    if (!circuit) return null;
    if (this.now() >= circuit.until) {
      this.open.delete(clientId);
      return null;
    }
    return circuit;
  }
}

/**
 * Instancia compartida del proceso. El worker la usa por default; los tests
 * inyectan la suya por `ProcessingContext.aiCircuitBreaker`.
 */
export const aiCircuitBreaker = new AiCircuitBreaker();
```

- [ ] **Step 4: Correr y verificar que pasa**

Run:
```bash
npx vitest run src/lib/aiCircuitBreaker.test.ts
```

Expected: PASS, 7 tests.

---

## Task 3: la cadena informa si la falla es de infraestructura

**Files:**
- Modify: `src/services/aiExtraction.ts`

El pipeline **no debe parsear mensajes** para clasificar (el comentario de `AiAttemptCallback` lo dice explícito: la redacción del mensaje puede cambiar). La cadena tiene el objeto de error, así que clasifica ella y lo propaga.

- [ ] **Step 1: Extender el tipo del callback**

En `src/services/aiExtraction.ts`, en la declaración de `AiAttemptCallback`, agregar el 5º parámetro:

```ts
export type AiAttemptCallback = (
  provider: AiProvider,
  ok: boolean,
  error?: string,
  rateLimited?: boolean,
  /**
   * La falla es de INFRAESTRUCTURA (429 / 503 / 402), no de contenido. Se calcula
   * acá, sobre el OBJETO del error, por el mismo motivo que `rateLimited`: los
   * callers no deben re-clasificar parseando el mensaje.
   */
  infrastructure?: boolean
) => void;
```

- [ ] **Step 2: Calcularlo en el `catch` de `run`**

En el mismo archivo, en `AiExtractionChain.run`, el `catch` pasa de:

```ts
        onAttempt?.(
          extractor.provider,
          false,
          error instanceof Error ? error.message : "Unknown error",
          isRateLimitError(error)
        );
```

a:

```ts
        onAttempt?.(
          extractor.provider,
          false,
          error instanceof Error ? error.message : "Unknown error",
          isRateLimitError(error),
          isInfrastructureFailure(error)
        );
```

Y el `import` del principio del archivo pasa de `import { isRateLimitError } from "@/lib/aiErrors";` a:

```ts
import { isRateLimitError, isInfrastructureFailure } from "@/lib/aiErrors";
```

- [ ] **Step 3: Verificar que no rompió nada**

Run:
```bash
npx vitest run src/services/aiExtraction.test.ts
```

Expected: PASS. El parámetro es opcional, así que los callers existentes siguen compilando.

---

## Task 4: el breaker se dispara desde `aiExtractStep`

**Files:**
- Modify: `src/jobs/processPendingDocuments.job.ts`
- Test: `src/jobs/processPendingDocuments.job.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Agregar en `src/jobs/processPendingDocuments.job.test.ts`, junto al test `rate_limited` existente:

```ts
  it("cadena caida por infraestructura: la PRIMERA boleta va a Pendientes, no a Revision", async () => {
    const ctx = makeContext({ driveProcessingFolderId: "processing" });
    // Reproduce la caída real: Gemini 429, Cerebras 402, OpenAI sin crédito.
    ctx.aiChain.run.mockImplementation(async (_t, cb) => {
      cb?.("gemini", false, "429 quota exceeded", true, true);
      cb?.("cerebras", false, "402 status code (no body)", false, true);
      cb?.("openai", false, "429 You have no credits remaining", true, true);
      return null;
    });
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.driveService.moveFileToFolder).toHaveBeenCalledWith("file-1", "processing", "pending");
    expect(summary.rateLimited).toBe(1);
    expect(summary.failed).toBe(0);
    // Lo que antes fallaba: el 402 de Cerebras rompía el guard y degradaba a OCR_ONLY.
    expect(ctx.driveService.moveFileToFailed).not.toHaveBeenCalled();
    expect(metricsCore().result).toBe("rate_limited");
  });

  it("falla de CONTENIDO en todos los proveedores: sigue degradando a OCR_ONLY", async () => {
    const ctx = makeContext();
    ctx.aiChain.run.mockImplementation(async (_t, cb) => {
      cb?.("gemini", false, "Unexpected token in JSON", false, false);
      return null;
    });
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    // OCR_ONLY → sin monto → Revisión. Comportamiento intencionalmente intacto.
    expect(metricsCore().result).toBe("no_amount");
  });
```

- [ ] **Step 2: Correr y verificar que falla**

Run:
```bash
npx vitest run src/jobs/processPendingDocuments.job.test.ts -t "cadena caida por infraestructura"
```

Expected: FAIL — `result` da `no_amount` en vez de `rate_limited`, porque el guard actual exige que todas las fallas sean 429.

- [ ] **Step 3: Sumar el breaker al `ProcessingContext`**

En `src/jobs/processPendingDocuments.job.ts`, agregar el import:

```ts
import { AiCircuitBreaker, aiCircuitBreaker as defaultAiCircuitBreaker } from "@/lib/aiCircuitBreaker";
```

Y al final del `export type ProcessingContext = { ... }`, antes del cierre:

```ts
  /**
   * Corta-corriente de la cadena de IA. Si no se inyecta, se usa el singleton del
   * proceso — que es lo que corresponde en producción, porque el estado tiene que
   * ser compartido entre los archivos del ciclo del worker.
   */
  aiCircuitBreaker?: AiCircuitBreaker;
```

- [ ] **Step 4: Cambiar el guard de `aiExtractStep`**

En `aiExtractStep`, la declaración de contadores pasa de:

```ts
    let aiFailures = 0;
    let aiRateLimited = 0;
```

a:

```ts
    let aiFailures = 0;
    let aiRateLimited = 0;
    let aiInfraFailures = 0;
```

El callback pasa de:

```ts
          (provider, ok, errorMsg, rateLimited) => {
            pipelineLog.aiExtraction(cid, provider, ok, errorMsg);
            if (!ok) {
              aiFailures += 1;
              if (rateLimited) aiRateLimited += 1;
            }
          },
```

a:

```ts
          (provider, ok, errorMsg, rateLimited, infrastructure) => {
            pipelineLog.aiExtraction(cid, provider, ok, errorMsg);
            if (!ok) {
              aiFailures += 1;
              if (rateLimited) aiRateLimited += 1;
              // `infrastructure` incluye el 402 (proveedor sin crédito), que
              // `rateLimited` no reconoce. Fallback a `rateLimited` para los
              // callers viejos que no lo mandan.
              if (infrastructure ?? rateLimited) aiInfraFailures += 1;
            }
          },
```

Y el guard pasa de:

```ts
    } else if (aiFailures > 0 && aiRateLimited === aiFailures) {
      // Todos los proveedores de IA caídos por algo transitorio — cuota agotada
      // (429) o servicio saturado (503, sumado el 2026-08-24): NO degradar a
      // OCR_ONLY (terminaría en Revisión). Se propaga como RateLimitError para
      // dejar la boleta en Pendientes y reintentarla en un ciclo posterior.
      throw new RateLimitError(`IA no disponible — ${aiFailures} proveedor(es) en 429/503`);
    } else {
```

a:

```ts
    } else if (aiFailures > 0 && aiInfraFailures === aiFailures) {
      // Todos los proveedores caídos por INFRAESTRUCTURA — cuota agotada (429),
      // servicio saturado (503) o proveedor sin crédito (402, sumado el
      // 2026-09-10): NO degradar a OCR_ONLY (terminaría en Revisión). Se propaga
      // como RateLimitError para dejar la boleta en Pendientes.
      //
      // Además se abre el CORTA-CORRIENTE: las boletas siguientes del ciclo ni
      // siquiera van a intentarlo. Sin esto, cada archivo vuelve a pagar el
      // barrido completo para redescubrir lo mismo (medido: 23 archivos, 134
      // requests, 2026-09-08/09).
      const reason = `${aiFailures} proveedor(es) caídos por 429/503/402`;
      (ctx.deps.aiCircuitBreaker ?? defaultAiCircuitBreaker).trip(cid, reason);
      pipelineLog.stepStart(cid, `🔌 Corta-corriente ABIERTO — ${reason}`);
      throw new RateLimitError(`IA no disponible — ${reason}`);
    } else {
```

- [ ] **Step 5: Correr y verificar que pasa**

Run:
```bash
npx vitest run src/jobs/processPendingDocuments.job.test.ts
```

Expected: PASS, incluidos los dos tests nuevos y **todos** los de caracterización.

> **Atención:** el test `rate_limited` existente llama `cb?.("gemini", false, "quota exceeded", true)` sin el 5º parámetro. El fallback `infrastructure ?? rateLimited` lo mantiene verde. Si falla, el fallback no se escribió bien.

---

## Task 5: `circuitBreakerGate`

**Files:**
- Modify: `src/jobs/processPendingDocuments.job.ts`
- Test: `src/jobs/processPendingDocuments.job.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

Agregar en `src/jobs/processPendingDocuments.job.test.ts`:

```ts
  it("breaker abierto: la boleta vuelve a Pendientes sin IA y sin extraer texto", async () => {
    const breaker = new AiCircuitBreaker(() => 1_000_000, 30 * 60 * 1000);
    breaker.trip("client-1", "caida previa");

    const ctx = makeContext({ driveProcessingFolderId: "processing" });
    const summary = createBaseSummary(1);

    await processDriveFile(
      makeFile(),
      { ...ctx, aiCircuitBreaker: breaker } as unknown as ProcessingContext,
      summary
    );

    expect(ctx.aiChain.run).not.toHaveBeenCalled();
    // El ahorro que motiva la ubicación del gate: no se paga el OCR.
    expect(ctx.pdfExtractor.extractTextFromPdf).not.toHaveBeenCalled();
    expect(ctx.driveService.moveFileToFolder).toHaveBeenCalledWith("file-1", "processing", "pending");
    expect(summary.rateLimited).toBe(1);
    expect(metricsCore().result).toBe("rate_limited");
  });

  it("breaker abierto: un DUPLICADO igual se resuelve, sin llamar a la IA", async () => {
    const breaker = new AiCircuitBreaker(() => 1_000_000, 30 * 60 * 1000);
    breaker.trip("client-1", "caida previa");

    const ctx = makeContext();
    // Duplicado por hash: `aiExtractStep` reusa la extracción guardada.
    ctx.invoiceRepository.findDuplicateByHash.mockResolvedValue({
      id: "inv-old",
      extraction: okExtraction(),
    });
    const summary = createBaseSummary(1);

    await processDriveFile(
      makeFile(),
      { ...ctx, aiCircuitBreaker: breaker } as unknown as ProcessingContext,
      summary
    );

    expect(ctx.aiChain.run).not.toHaveBeenCalled();
    // Lo importante: NO rebota a Pendientes, sigue su camino de duplicado.
    expect(metricsCore().result).toBe("duplicate");
  });

  it("breaker cerrado: el pipeline corre normal", async () => {
    const breaker = new AiCircuitBreaker(() => 1_000_000, 30 * 60 * 1000);

    const ctx = makeContext();
    const summary = createBaseSummary(1);

    await processDriveFile(
      makeFile(),
      { ...ctx, aiCircuitBreaker: breaker } as unknown as ProcessingContext,
      summary
    );

    expect(ctx.aiChain.run).toHaveBeenCalledTimes(1);
    expect(metricsCore().result).toBe("ok");
  });
```

Agregar el import al principio del archivo de test:

```ts
import { AiCircuitBreaker } from "@/lib/aiCircuitBreaker";
```

- [ ] **Step 2: Correr y verificar que falla**

Run:
```bash
npx vitest run src/jobs/processPendingDocuments.job.test.ts -t "breaker abierto"
```

Expected: FAIL — el pipeline ignora el breaker y procesa normal.

- [ ] **Step 3: Implementar el gate**

En `src/jobs/processPendingDocuments.job.ts`, agregar la función justo **antes** de `textExtractStep`:

```ts
/**
 * 2b. CORTA-CORRIENTE: si la cadena de IA está cortada para este cliente, la
 * boleta vuelve a Pendientes sin gastar nada.
 *
 * Va **entre `dedupHash` y `textExtract`** a propósito: chequear acá ahorra
 * también la extracción de texto, que en PDFs escaneados hace OCR con tesseract
 * —lo más caro en CPU del pipeline—. La descarga no se puede evitar: el hash del
 * dedup se calcula sobre el binario.
 *
 * **El duplicado es la excepción y no puede cortarse.** No llama a la cadena:
 * `aiExtractStep` reusa la extracción guardada (`existingByHash.extraction`) y
 * por eso registra `aiRequests = 0` aunque recorra todos los pasos. Frenarlo acá
 * lo mandaría a Pendientes en vez de a Duplicados.
 */
async function circuitBreakerGate(ctx: PipelineContext): Promise<StepResult> {
  if (ctx.isDuplicate) return { kind: "continue" };

  const breaker = ctx.deps.aiCircuitBreaker ?? defaultAiCircuitBreaker;
  const cid = ctx.deps.resolvedConfig.clientId;
  if (!breaker.isOpen(cid)) return { kind: "continue" };

  const reason = breaker.reasonFor(cid) ?? "cadena de IA no disponible";
  pipelineLog.stepStart(cid, `🔌 Corta-corriente ABIERTO — se saltea la IA: ${reason}`);
  throw new RateLimitError(`Corta-corriente abierto — ${reason}`);
}
```

- [ ] **Step 4: Insertarlo en el pipeline**

En `processDriveFile`, el array de `runPipeline` pasa de:

```ts
      downloadAndLockStep,
      dedupHashStep,
      textExtractStep,
```

a:

```ts
      downloadAndLockStep,
      dedupHashStep,
      circuitBreakerGate,
      textExtractStep,
```

- [ ] **Step 5: Correr y verificar que pasa**

Run:
```bash
npx vitest run src/jobs/processPendingDocuments.job.test.ts
```

Expected: PASS, incluidos los tres tests nuevos y toda la red de caracterización.

---

## Task 6: `reasonCategory = "circuit_open"`

**Files:**
- Modify: `src/jobs/processPendingDocuments.job.ts`
- Test: `src/jobs/processPendingDocuments.job.test.ts`

Hoy el `catch` del runner pone `m.reason = "rate_limit"` para todo `RateLimitError`. Hay que distinguir las boletas frenadas por el corte, que son las que permiten medir cuánto ahorró.

- [ ] **Step 1: Escribir el test que falla**

Agregar en `src/jobs/processPendingDocuments.job.test.ts`:

```ts
  it("breaker abierto: la metrica queda etiquetada circuit_open", async () => {
    const breaker = new AiCircuitBreaker(() => 1_000_000, 30 * 60 * 1000);
    breaker.trip("client-1", "caida previa");

    const ctx = makeContext();
    const summary = createBaseSummary(1);

    await processDriveFile(
      makeFile(),
      { ...ctx, aiCircuitBreaker: breaker } as unknown as ProcessingContext,
      summary
    );

    expect(metricsCore().result).toBe("rate_limited");
    expect(metricsCore().reason).toBe("circuit_open");
  });
```

- [ ] **Step 2: Correr y verificar que falla**

Run:
```bash
npx vitest run src/jobs/processPendingDocuments.job.test.ts -t "circuit_open"
```

Expected: FAIL — `reason` da `"rate_limit"`.

- [ ] **Step 3: Implementar**

En `src/lib/aiErrors.ts`, agregar una subclase para que el runner pueda distinguir sin parsear el mensaje:

```ts
/**
 * El corta-corriente frenó la boleta antes de intentar la IA. Es un
 * `RateLimitError` —así hereda el camino "vuelve a Pendientes"— pero se
 * distingue para poder medirlo aparte en `ProcessingJob.reasonCategory`.
 */
export class CircuitOpenError extends RateLimitError {
  constructor(message: string) {
    super(message);
    this.name = "CircuitOpenError";
  }
}
```

En `circuitBreakerGate` (Task 5, Step 3), reemplazar el `throw` final por:

```ts
  throw new CircuitOpenError(`Corta-corriente abierto — ${reason}`);
```

y agregar `CircuitOpenError` al import de `@/lib/aiErrors` en `processPendingDocuments.job.ts`.

En el `catch` de `runPipeline` (`src/jobs/pipeline/runner.ts`), donde hoy dice:

```ts
    if (error instanceof RateLimitError) {
      m.result = "rate_limited";
      m.reason = "rate_limit";
```

pasa a:

```ts
    if (error instanceof RateLimitError) {
      m.result = "rate_limited";
      // `CircuitOpenError` es un RateLimitError: mismo camino (vuelve a
      // Pendientes), categoría distinta para poder medir cuántas boletas frenó
      // el corta-corriente sin gastar una sola request.
      m.reason = error instanceof CircuitOpenError ? "circuit_open" : "rate_limit";
```

con el import correspondiente en `runner.ts`.

- [ ] **Step 4: Correr y verificar que pasa**

Run:
```bash
npx vitest run src/jobs/processPendingDocuments.job.test.ts
```

Expected: PASS. El test `rate_limited` original tiene que seguir dando `reason: "rate_limit"`.

---

## Task 7: Verificación completa

**Files:** ninguno

- [ ] **Step 1: Typecheck**

Run:
```bash
npm run typecheck
```

Expected: 0 errores.

- [ ] **Step 2: Suite completa**

Run:
```bash
npx vitest run
```

Expected: PASS. El total tiene que ser el de Task 0 **más 22**: 9 en `aiErrors.test.ts` (6 de `isProviderDownError` + 3 de "no se pisan"), 7 en `aiCircuitBreaker.test.ts`, y 6 en `processPendingDocuments.job.test.ts` (2 de Task 4, 3 de Task 5, 1 de Task 6).

- [ ] **Step 3: Lint**

Run:
```bash
npm run lint
```

Expected: 0 errores.

- [ ] **Step 4: Build de los jobs**

Run:
```bash
npm run build:jobs
```

Expected: build OK. Es el que valida que el worker compila.

---

## Task 8: Documentación

**Files:**
- Modify: `docs/progreso.md`
- Modify: `docs/decisiones.md`
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`
- Modify: `scripts/metrics-cuota.sql`

- [ ] **Step 1: `docs/decisiones.md`**

Entrada nueva con fecha 2026-09-10: el problema (24 archivos a Revisión con SIN MONTO, 135 requests, con el experimento controlado de las 4 boletas que entraron al día siguiente sin ningún alta), la decisión (corta-corriente por cliente con cooldown de 30 min + el 402 clasificado como infraestructura), las alternativas descartadas (corte hasta vaciar la cola, hasta reiniciar, estado en la base) y el impacto (archivos tocados).

Incluir el apartamiento del precedente del spec del 2026-08-24 sobre meter tiempo en el estado, con el motivo.

- [ ] **Step 2: `docs/progreso.md`**

Sección nueva con el estado. Y **reemplazar** la sección "⏳ Lo único que quedaría: adelantar la regla antes de la IA" por el resultado de §7.1 del spec: se midió (13 requests en 2 días), se evaluaron cuatro reglas, ninguna paga, y la razón estructural (`provider_cuit_not_registered` sólo existe si el consorcio ya matcheó).

- [ ] **Step 3: `CHANGELOG.md`**

En `[Unreleased]`, bloque `### Fixed` y `### Added` según corresponda, con el número medido: 128 de 263 requests.

- [ ] **Step 4: `CLAUDE.md`**

Corregir el techo de cuota de Gemini: donde dice "~20 requests" por modelo, poner lo medido (~34-40 por modelo, ~35 boletas limpias por día) y agregar que el reset es a medianoche del Pacífico (04:00 AR) y que el límite es por proyecto, no por API key.

Agregar `circuitBreakerGate` al paso 4 de la descripción del pipeline.

- [ ] **Step 5: `scripts/metrics-cuota.sql`**

Corregir el comentario del encabezado que dice "~20 requests/día POR MODELO … el piso de referencia son ~60 requests/día".

Agregar la consulta de verificación del corte:

```sql
-- ─────────────────────────────────────────────────────────────────────────────
-- 5) Corta-corriente: cuántas boletas frenó y cuánto gastaron.
--    CONTROL: `requests` tiene que dar 0 — el corte va ANTES de llamar a la IA.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT "createdAt"::date AS dia,
       count(*)          AS boletas_frenadas,
       sum("aiRequests") AS requests
FROM "ProcessingJob"
WHERE "reasonCategory" = 'circuit_open'
GROUP BY 1
ORDER BY 1 DESC;
```

- [ ] **Step 6: Avisar al owner**

El trabajo queda **listo para commitear**. No commitear ni pushear.
