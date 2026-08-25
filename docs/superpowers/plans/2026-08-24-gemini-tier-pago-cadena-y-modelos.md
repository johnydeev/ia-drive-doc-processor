# Gemini como proveedor principal — Plan de implementación

> **Para workers agénticos:** SUB-SKILL REQUERIDA: usar `superpowers:executing-plans` para
> ejecutar tarea por tarea. Los pasos usan checkbox (`- [ ]`).

> **⚠️ Este proyecto NO commitea desde Claude.** Regla del owner (`CLAUDE.md` global): los
> commits y el staging los hace él con GitLens. Donde un plan normal diría "Commit", acá hay
> un **Checkpoint**: dejar el árbol verde y avisar. No ejecutar `git add` ni `git commit`.

**Goal:** dejar el código listo para que una cuenta paga de Gemini sea el proveedor principal,
sin que el barrido de modelos —diseñado para el free tier— degrade calidad, mande boletas
sanas a Revisión o fije el proceso en el modelo más caro.

**Architecture:** seis cambios acotados sobre dos archivos de producción
(`src/lib/aiErrors.ts`, `src/services/geminiExtractor.service.ts`) más el armado de la cadena
(`src/services/aiExtraction.ts`). Sin migración, sin UI, sin config nueva. Se introduce un
seam de test en `GeminiExtractorService` (hoy no tiene tests) para poder ejercitar el barrido
sin red.

**Tech Stack:** TypeScript, Vitest (proyecto `node`, archivos `*.test.ts`),
`@google/generative-ai`.

**Spec:** `docs/superpowers/specs/2026-08-24-gemini-tier-pago-cadena-y-modelos-design.md`

---

## Estructura de archivos

| Archivo | Responsabilidad | Acción |
|---|---|---|
| `src/lib/aiErrors.ts` | Clasificación de errores de proveedores de IA | Modificar: agregar `isTransientServerError` |
| `src/lib/aiErrors.test.ts` | Tests de clasificación | Modificar: nuevo `describe` |
| `src/services/aiExtraction.ts` | Contrato + cadena de fallback | Modificar: orden explícito por array |
| `src/services/aiExtraction.test.ts` | Tests de la cadena | Modificar: invertir el orden esperado |
| `src/services/geminiExtractor.service.ts` | Extractor Gemini (texto, visión, partes) | Modificar: poda, seams, retry, sticky, usage |
| `src/services/geminiExtractor.service.test.ts` | Tests del barrido de modelos | **Crear** |

**Orden de las tareas:** la Tarea 3 crea el seam de test que necesitan las Tareas 4, 5, 6 y 7.
No se puede reordenar sin romper eso.

**Comandos del proyecto** (PowerShell — **nunca encadenar con `&&`**, un comando por línea):

```bash
npx vitest run src/lib/aiErrors.test.ts
```

---

## Tarea 1: Clasificador de error transitorio de servidor

**Files:**
- Modify: `src/lib/aiErrors.ts`
- Test: `src/lib/aiErrors.test.ts`

- [ ] **Paso 1: Escribir el test que falla**

Agregar al final de `src/lib/aiErrors.test.ts`:

```ts
describe("isTransientServerError", () => {
  it("detecta el 503 de alta demanda de Gemini", () => {
    const err = new Error(
      "[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent: [503 Service Unavailable] This model is currently experiencing high demand."
    );
    expect(isTransientServerError(err)).toBe(true);
  });

  it("detecta el status 503 numérico del SDK de OpenAI", () => {
    expect(isTransientServerError({ status: 503 })).toBe(true);
  });

  it("detecta el UNAVAILABLE de gRPC", () => {
    expect(isTransientServerError(new Error("UNAVAILABLE: backend closed"))).toBe(true);
  });

  it("detecta 'overloaded'", () => {
    expect(isTransientServerError(new Error("The model is overloaded. Try again later."))).toBe(true);
  });

  it("NO confunde el 404 de modelo dado de baja", () => {
    const err = new Error(
      "[GoogleGenerativeAI Error]: [404 Not Found] This model models/gemini-2.0-flash is no longer available."
    );
    expect(isTransientServerError(err)).toBe(false);
  });

  it("NO confunde un 429 de cuota", () => {
    expect(isTransientServerError(new Error("429 You exceeded your current quota"))).toBe(false);
  });

  it("NO matchea un 5030 que contenga 503", () => {
    expect(isTransientServerError(new Error("codigo interno 5030"))).toBe(false);
  });

  it("tolera null y undefined", () => {
    expect(isTransientServerError(null)).toBe(false);
    expect(isTransientServerError(undefined)).toBe(false);
  });
});
```

Y agregar `isTransientServerError` al import de la línea 2 del mismo archivo:

```ts
import { isRateLimitError, isTransientServerError, RateLimitError, callWithRetry } from "@/lib/aiErrors";
```

- [ ] **Paso 2: Correr el test y verificar que falla**

```bash
npx vitest run src/lib/aiErrors.test.ts
```

Esperado: FAIL — `isTransientServerError is not a function` (o error de TypeScript por el
import inexistente).

- [ ] **Paso 3: Implementar**

En `src/lib/aiErrors.ts`, después de `isRateLimitError` (que termina en la línea 49):

```ts
/**
 * Devuelve true si el error es una caída transitoria DEL LADO DEL PROVEEDOR
 * (HTTP 503 / servicio saturado), distinta de la cuota agotada (429) que ya
 * clasifica `isRateLimitError`.
 *
 * La distinción importa: ante 429 no tiene sentido reintentar el mismo modelo
 * (la cuota no vuelve en 2 segundos), ante 503 sí (es capacidad momentánea).
 *
 * Se usa `\b503\b` por el mismo motivo que el 429: no confundir un "5030".
 * El 404 de un modelo dado de baja dice "no longer available", que NO contiene
 * la subcadena "unavailable" — por eso no da falso positivo.
 */
export function isTransientServerError(error: unknown): boolean {
  if (error === null || error === undefined) return false;

  if (typeof error === "object") {
    const e = error as { status?: unknown };
    if (e.status === 503) return true;
  }

  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();

  return (
    /\b503\b/.test(text) ||
    text.includes("service unavailable") ||
    text.includes("unavailable") ||
    text.includes("overloaded") ||
    text.includes("high demand")
  );
}
```

- [ ] **Paso 4: Correr el test y verificar que pasa**

```bash
npx vitest run src/lib/aiErrors.test.ts
```

Esperado: PASS, 8 tests nuevos.

- [ ] **Paso 5: Checkpoint**

Dejar el árbol verde. No commitear.

---

## Tarea 2: Orden de la cadena explícito, Gemini primero

**Files:**
- Modify: `src/services/aiExtraction.ts:106-162`
- Test: `src/services/aiExtraction.test.ts:157-176`

- [ ] **Paso 1: Escribir el test que falla**

Reemplazar el bloque `describe("createAiExtractionChain — orden capacidad-primero", ...)`
completo (líneas 157-176 de `src/services/aiExtraction.test.ts`) por:

```ts
describe("createAiExtractionChain — Gemini primero", () => {
  it("ordena Gemini → Cerebras → OpenAI → Claude cuando todos tienen key", async () => {
    const chain = await createAiExtractionChain({
      cerebras: { apiKey: "x", model: "llama-3.3-70b" },
      gemini: { apiKey: "x" },
      openai: { apiKey: "x" },
      anthropic: { apiKey: "x" },
    });
    expect(chain.providerOrder).toEqual(["gemini", "cerebras", "openai", "anthropic"]);
  });

  it("mete a Groq entre Cerebras y OpenAI si tiene key", async () => {
    const chain = await createAiExtractionChain({
      cerebras: { apiKey: "x" },
      groq: { apiKey: "x" },
      gemini: { apiKey: "x" },
      openai: { apiKey: "x" },
    });
    expect(chain.providerOrder).toEqual(["gemini", "cerebras", "groq", "openai"]);
  });

  it("incluye solo los proveedores con apiKey presente", async () => {
    const chain = await createAiExtractionChain({
      cerebras: { apiKey: "x" },
      groq: {},
      gemini: { apiKey: "" },
    });
    expect(chain.providerOrder).toEqual(["cerebras"]);
  });
});
```

- [ ] **Paso 2: Correr el test y verificar que falla**

```bash
npx vitest run src/services/aiExtraction.test.ts
```

Esperado: FAIL en los dos primeros tests — recibe `["cerebras", "gemini", "openai", "anthropic"]`
en vez de `["gemini", "cerebras", "openai", "anthropic"]`.

- [ ] **Paso 3: Implementar**

Reemplazar en `src/services/aiExtraction.ts` el bloque de comentario + función que va desde la
línea 106 (`/**` de `createAiExtractionChain`) hasta el final del archivo, por:

```ts
/**
 * Una entrada del orden de fallback: qué proveedor es, de dónde saca sus
 * credenciales y cómo se construye su extractor.
 *
 * El orden de este array ES el orden de fallback. Antes salía del orden físico
 * de cinco bloques `if`, así que para saber quién iba primero había que leer la
 * función entera.
 */
interface ProviderSlot {
  provider: AiProvider;
  credentials: (config: AiExtractionChainConfig) => AiProviderCredentials | undefined;
  build: (credentials: AiProviderCredentials) => Promise<AiExtractor>;
}

/**
 * Orden de fallback: **Gemini → Cerebras → Groq → OpenAI → Claude**.
 *
 * Gemini pasó a primero el 2026-08-24, con la cuenta paga: resolvía el 77% de
 * las boletas incluso yendo segundo, y Cerebras venía devolviendo 402 (sin
 * cuota). Cerebras queda de segundo, no se saca.
 *
 * Groq está en el array pero fuera de producción desde 2026-06-25: sin
 * `apiKey` no se instancia. El banco de pruebas lo usa por separado.
 */
const PROVIDER_ORDER: ProviderSlot[] = [
  {
    provider: "gemini",
    credentials: (c) => c.gemini,
    build: async (creds) => {
      const { GeminiExtractorService } = await import("@/services/geminiExtractor.service");
      return new GeminiExtractorService({ apiKey: creds.apiKey, model: creds.model });
    },
  },
  {
    provider: "cerebras",
    credentials: (c) => c.cerebras,
    build: async (creds) => {
      const { OpenAICompatibleExtractorService } = await import("@/services/openAICompatibleExtractor.service");
      return new OpenAICompatibleExtractorService({
        provider: "cerebras",
        apiKey: creds.apiKey!,
        baseURL: "https://api.cerebras.ai/v1",
        model: creds.model?.trim() || "gpt-oss-120b",
      });
    },
  },
  {
    provider: "groq",
    credentials: (c) => c.groq,
    build: async (creds) => {
      const { OpenAICompatibleExtractorService } = await import("@/services/openAICompatibleExtractor.service");
      return new OpenAICompatibleExtractorService({
        provider: "groq",
        apiKey: creds.apiKey!,
        baseURL: "https://api.groq.com/openai/v1",
        model: creds.model?.trim() || "llama-3.3-70b-versatile",
      });
    },
  },
  {
    provider: "openai",
    credentials: (c) => c.openai,
    build: async (creds) => {
      const { AiExtractorService } = await import("@/services/aiExtractor.service");
      return new AiExtractorService({ apiKey: creds.apiKey, model: creds.model });
    },
  },
  {
    provider: "anthropic",
    credentials: (c) => c.anthropic,
    build: async (creds) => {
      const { ClaudeExtractorService } = await import("@/services/claudeExtractor.service");
      return new ClaudeExtractorService({ apiKey: creds.apiKey, model: creds.model });
    },
  },
];

/**
 * Construye la cadena recorriendo `PROVIDER_ORDER` e importando dinámicamente
 * solo los servicios cuyos proveedores tienen API key (mantiene la carga
 * perezosa de SDKs que ya tenía el pipeline).
 */
export async function createAiExtractionChain(
  config: AiExtractionChainConfig
): Promise<AiExtractionChain> {
  const extractors: AiExtractor[] = [];

  for (const slot of PROVIDER_ORDER) {
    const creds = slot.credentials(config);
    if (!creds?.apiKey) continue;
    extractors.push(await slot.build(creds));
  }

  return new AiExtractionChain(extractors);
}
```

Actualizar también el comentario del `AiExtractionChainConfig` (líneas 25-30), que hoy dice el
orden viejo:

```ts
/**
 * Configuración para construir la cadena. El orden de fallback lo define
 * `PROVIDER_ORDER`: Gemini → Cerebras → Groq → OpenAI → Claude. Solo se
 * incluyen los proveedores que tienen `apiKey` presente; en producción Groq
 * está fuera de la cadena (sin API key) desde 2026-06-25.
 */
```

- [ ] **Paso 4: Correr el test y verificar que pasa**

```bash
npx vitest run src/services/aiExtraction.test.ts
```

Esperado: PASS.

- [ ] **Paso 5: Verificar que el pipeline sigue verde**

```bash
npx vitest run src/jobs/processPendingDocuments.job.test.ts
```

Esperado: PASS. Son los tests de caracterización del pipeline: si el cambio de orden rompió
un camino de salida, aparece acá.

- [ ] **Paso 6: Checkpoint**

Dejar el árbol verde. No commitear.

---

## Tarea 3: Seam de test + poda de modelos muertos

Esta tarea no cambia comportamiento salvo la poda. Su trabajo principal es hacer testeable
`GeminiExtractorService`, que hoy no tiene ni un test porque construye el SDK en el
constructor y crea los modelos con un método privado.

**Files:**
- Modify: `src/services/geminiExtractor.service.ts`
- Create: `src/services/geminiExtractor.service.test.ts`

- [ ] **Paso 1: Escribir el test que falla**

Crear `src/services/geminiExtractor.service.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import type { GenerativeModel } from "@google/generative-ai";
import { GeminiExtractorService } from "@/services/geminiExtractor.service";

/** Respuesta exitosa con la forma que devuelve el SDK. */
export function okResponse(overrides: Record<string, unknown> = {}) {
  const payload = {
    boletaNumber: "0001-00000001",
    provider: "PROVEEDOR SA",
    consortium: "CALLE FALSA 123",
    providerTaxId: "30-71497816-7",
    amount: 1000,
    dueDate: "2026-09-10",
    ...overrides,
  };
  return {
    response: {
      text: () => JSON.stringify(payload),
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 },
    },
  };
}

export function httpError(status: number, message: string): Error {
  return new Error(`[GoogleGenerativeAI Error]: [${status} ${message}]`);
}

/**
 * Fake del servicio: sustituye `getModel` por uno que consume una cola de
 * desenlaces por modelo. Cuando la cola se agota repite el último.
 */
export class FakeGemini extends GeminiExtractorService {
  public readonly calls: string[] = [];
  public readonly slept: number[] = [];
  private readonly queues: Map<string, Array<Error | ReturnType<typeof okResponse>>>;

  constructor(behavior: Record<string, Array<Error | ReturnType<typeof okResponse>>>) {
    const slept: number[] = [];
    super({
      apiKey: "test-key",
      sleep: async (ms: number) => { slept.push(ms); },
    });
    this.slept = slept;
    this.queues = new Map(Object.entries(behavior).map(([k, v]) => [k, [...v]]));
  }

  protected getModel(modelName: string): GenerativeModel {
    return {
      generateContent: async () => {
        this.calls.push(modelName);
        const queue = this.queues.get(modelName);
        if (!queue || queue.length === 0) throw httpError(404, "Not Found");
        const outcome = queue.length === 1 ? queue[0] : queue.shift()!;
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    } as unknown as GenerativeModel;
  }
}

beforeEach(() => {
  GeminiExtractorService.resetWorkingModel();
});

describe("GeminiExtractorService — candidatos de modelo", () => {
  it("arranca por gemini-2.5-flash-lite y no llama a otro si responde", async () => {
    const fake = new FakeGemini({ "gemini-2.5-flash-lite": [okResponse()] });
    await fake.extractStructuredData("CUIT 30-71497816-7 TOTAL 1000");
    expect(fake.calls).toEqual(["gemini-2.5-flash-lite"]);
  });

  it("no incluye los modelos 2.0, dados de baja por Google", async () => {
    const fake = new FakeGemini({});
    await expect(fake.extractStructuredData("texto")).rejects.toThrow();
    expect(fake.calls).not.toContain("gemini-2.0-flash");
    expect(fake.calls).not.toContain("gemini-2.0-flash-lite");
  });

  it("barre exactamente los 3 modelos vivos", async () => {
    const fake = new FakeGemini({});
    await expect(fake.extractStructuredData("texto")).rejects.toThrow();
    expect(fake.calls).toEqual([
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash",
      "gemini-flash-latest",
    ]);
  });
});
```

- [ ] **Paso 2: Correr el test y verificar que falla**

```bash
npx vitest run src/services/geminiExtractor.service.test.ts
```

Esperado: FAIL — `resetWorkingModel is not a function`, `getModel` no es sobreescribible
(TypeScript: es privado) y el constructor no acepta `sleep`.

- [ ] **Paso 3: Implementar los seams y la poda**

En `src/services/geminiExtractor.service.ts`:

**3a.** Reemplazar el bloque `DEFAULT_MODEL_CANDIDATES` (comentario de las líneas 13-27 más el
array de la 28) por:

```ts
/**
 * Modelos candidatos del barrido.
 *
 * HISTORIA (2026-06-11): el free tier tiene cuota DIARIA POR MODELO
 * ("GenerateRequestsPerDayPerProjectPerModel-FreeTier", p. ej. limit=20 para
 * 2.5-flash-lite). Como cada modelo es un balde independiente, barrer SUMABA
 * baldes y era la estrategia correcta en free tier.
 *
 * HOY (2026-08-24, cuenta paga): el barrido ya no existe para sumar cuota —
 * existe porque el **503 de alta demanda** de Google no desaparece en tier
 * pago. Con tier pago el primer modelo responde casi siempre; el barrido es la
 * red para el rato en que no responde.
 *
 * Se podaron `gemini-2.0-flash` y `gemini-2.0-flash-lite`: Google los dio de
 * baja y devuelven 404. Estaban gastando dos intentos garantizados al vacío
 * cada vez que los tres primeros daban 503.
 *
 * Si TODOS los modelos fallan con error transitorio (429 o 503) se lanza
 * `RateLimitError` → el pipeline devuelve la boleta a Pendientes.
 */
const DEFAULT_MODEL_CANDIDATES = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-flash-latest",
];

/** Espera antes de reintentar el MISMO modelo tras un 503. */
const TRANSIENT_RETRY_BACKOFF_MS = 2000;
```

**3b.** Reemplazar el constructor y los campos privados (líneas 50-67 aprox.) por:

```ts
export interface GeminiExtractorOptions {
  apiKey?: string;
  model?: string;
  /** Inyectable para tests: evita esperas reales en el reintento del 503. */
  sleep?: (ms: number) => Promise<void>;
}

export class GeminiExtractorService implements AiExtractor {
  readonly provider = "gemini" as const;
  /** Último modelo que funcionó (compartido entre instancias): arranca el barrido ahí. */
  private static workingModelName: string | null = null;
  private readonly genAI: GoogleGenerativeAI;
  private readonly preferredModel?: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastUsage: AiUsageMetrics | null = null;

  constructor(options?: GeminiExtractorOptions) {
    const apiKey = options?.apiKey?.trim() || env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not configured");
    }

    this.genAI = new GoogleGenerativeAI(apiKey);
    this.preferredModel = options?.model?.trim() || env.GEMINI_MODEL?.trim() || undefined;
    this.sleep = options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Solo para tests: el modelo pegajoso es estático y sobrevive entre casos. */
  static resetWorkingModel(): void {
    GeminiExtractorService.workingModelName = null;
  }

  /** Solo para tests y diagnóstico. */
  static get workingModel(): string | null {
    return GeminiExtractorService.workingModelName;
  }
```

**3c.** Cambiar `private getModel` (línea 93 aprox.) a `protected`:

```ts
  protected getModel(modelName: string): GenerativeModel {
    return this.genAI.getGenerativeModel({ model: modelName });
  }
```

- [ ] **Paso 4: Correr el test y verificar que pasa**

```bash
npx vitest run src/services/geminiExtractor.service.test.ts
```

Esperado: PASS, 3 tests.

- [ ] **Paso 5: Verificar que nada más se rompió**

```bash
npm run typecheck
```

Esperado: 0 errores. El constructor pasó de `{ apiKey?, model? }` a `GeminiExtractorOptions`,
que es un superconjunto — los tres call sites existentes (`aiExtraction.ts`,
`processPendingDocuments.job.ts`, `scripts/llm-testbench.ts`) siguen compilando.

- [ ] **Paso 6: Checkpoint**

Dejar el árbol verde. No commitear.

---

## Tarea 4: Reintento del mismo modelo ante 503

**Files:**
- Modify: `src/services/geminiExtractor.service.ts`
- Test: `src/services/geminiExtractor.service.test.ts`

- [ ] **Paso 1: Escribir el test que falla**

Agregar a `src/services/geminiExtractor.service.test.ts`:

```ts
describe("GeminiExtractorService — reintento ante 503", () => {
  it("reintenta el MISMO modelo una vez antes de saltar", async () => {
    const fake = new FakeGemini({
      "gemini-2.5-flash-lite": [httpError(503, "Service Unavailable"), okResponse()],
    });
    await fake.extractStructuredData("CUIT 30-71497816-7 TOTAL 1000");
    expect(fake.calls).toEqual(["gemini-2.5-flash-lite", "gemini-2.5-flash-lite"]);
  });

  it("espera 2000 ms entre el intento y el reintento", async () => {
    const fake = new FakeGemini({
      "gemini-2.5-flash-lite": [httpError(503, "Service Unavailable"), okResponse()],
    });
    await fake.extractStructuredData("CUIT 30-71497816-7 TOTAL 1000");
    expect(fake.slept).toEqual([2000]);
  });

  it("reintenta una sola vez: si el 503 se repite, salta al siguiente modelo", async () => {
    const fake = new FakeGemini({
      "gemini-2.5-flash-lite": [httpError(503, "Service Unavailable")],
      "gemini-2.5-flash": [okResponse()],
    });
    await fake.extractStructuredData("CUIT 30-71497816-7 TOTAL 1000");
    expect(fake.calls).toEqual([
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash",
    ]);
  });

  it("NO reintenta ante 429: la cuota no vuelve en 2 segundos", async () => {
    const fake = new FakeGemini({
      "gemini-2.5-flash-lite": [httpError(429, "Too Many Requests")],
      "gemini-2.5-flash": [okResponse()],
    });
    await fake.extractStructuredData("CUIT 30-71497816-7 TOTAL 1000");
    expect(fake.calls).toEqual(["gemini-2.5-flash-lite", "gemini-2.5-flash"]);
    expect(fake.slept).toEqual([]);
  });

  it("NO reintenta ante 404: el modelo no existe más", async () => {
    const fake = new FakeGemini({
      "gemini-2.5-flash-lite": [httpError(404, "Not Found")],
      "gemini-2.5-flash": [okResponse()],
    });
    await fake.extractStructuredData("CUIT 30-71497816-7 TOTAL 1000");
    expect(fake.calls).toEqual(["gemini-2.5-flash-lite", "gemini-2.5-flash"]);
  });
});
```

- [ ] **Paso 2: Correr el test y verificar que falla**

```bash
npx vitest run src/services/geminiExtractor.service.test.ts
```

Esperado: FAIL — el primer test recibe `["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-flash-latest"]`
(salta de una en vez de reintentar).

- [ ] **Paso 3: Implementar**

Agregar el import de `isTransientServerError` en la línea 10 de
`src/services/geminiExtractor.service.ts`:

```ts
import { isRateLimitError, isTransientServerError, RateLimitError } from "@/lib/aiErrors";
```

Agregar el helper después de `getModel`:

```ts
  /**
   * Llama a un modelo reintentándolo UNA vez si el error es transitorio (503).
   *
   * Saltar de modelo ante un 503 no está mal —la boleta se resuelve igual— pero
   * la resuelve un modelo distinto del que le tocaba, con otra calidad y otro
   * precio. Un reintento corto sobre el mismo modelo evita esa degradación
   * silenciosa. Un solo reintento: dos sumarían 4 s por modelo, y el peor caso
   * medido en producción ya fue de 187 s.
   *
   * Los errores no transitorios (429, 404, parseo) se propagan sin reintentar:
   * la cuota no vuelve en 2 segundos y un modelo dado de baja no revive.
   */
  private async generateWithTransientRetry(
    modelName: string,
    request: Parameters<GenerativeModel["generateContent"]>[0]
  ): Promise<GenerateContentResult> {
    try {
      return await this.getModel(modelName).generateContent(request);
    } catch (error) {
      if (!isTransientServerError(error)) throw error;
      await this.sleep(TRANSIENT_RETRY_BACKOFF_MS);
      return await this.getModel(modelName).generateContent(request);
    }
  }
```

En `extractStructuredData`, reemplazar el cuerpo del `try` del `for` por una llamada al
helper. El bloque queda:

```ts
    for (const modelName of this.buildModelCandidates()) {
      try {
        const result = await this.generateWithTransientRetry(modelName, {
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        });
        const outputText = result.response.text() || "{}";
        const parsed = parseExtractionOutput(outputText);
        const refined = refineExtractionWithRawText(parsed, text);
        this.captureUsage(modelName, result);
        GeminiExtractorService.workingModelName = modelName;
        return refined;
      } catch (error) {
        errors.push(`${modelName}: ${normalizeError(error)}`);
      }
    }
```

Hacer el mismo reemplazo en `extractStructuredDataFromImage` y en `extractPartiesFromImage`:
las tres barren modelos con la misma forma, y dejar el reintento en una sola de ellas crearía
un tercer comportamiento distinto para el mismo error. En `extractPartiesFromImage` la llamada
pasa a ser:

```ts
        const result = await this.generateWithTransientRetry(modelName, {
          contents,
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        });
```

- [ ] **Paso 4: Correr el test y verificar que pasa**

```bash
npx vitest run src/services/geminiExtractor.service.test.ts
```

Esperado: PASS, 8 tests.

- [ ] **Paso 5: Checkpoint**

Dejar el árbol verde. No commitear.

---

## Tarea 5: Un 503 en todos los modelos devuelve la boleta a Pendientes

**Files:**
- Modify: `src/services/geminiExtractor.service.ts`
- Modify: `src/jobs/processPendingDocuments.job.ts:803`
- Test: `src/services/geminiExtractor.service.test.ts`

- [ ] **Paso 1: Escribir el test que falla**

Agregar a `src/services/geminiExtractor.service.test.ts` (y sumar `RateLimitError` al import
de arriba: `import { RateLimitError } from "@/lib/aiErrors";`):

```ts
describe("GeminiExtractorService — desenlace del barrido completo", () => {
  it("lanza RateLimitError si TODOS los modelos dieron 503", async () => {
    const fake = new FakeGemini({
      "gemini-2.5-flash-lite": [httpError(503, "Service Unavailable")],
      "gemini-2.5-flash": [httpError(503, "Service Unavailable")],
      "gemini-flash-latest": [httpError(503, "Service Unavailable")],
    });
    await expect(fake.extractStructuredData("texto")).rejects.toBeInstanceOf(RateLimitError);
  });

  it("lanza RateLimitError si TODOS los modelos dieron 429", async () => {
    const fake = new FakeGemini({
      "gemini-2.5-flash-lite": [httpError(429, "Too Many Requests")],
      "gemini-2.5-flash": [httpError(429, "Too Many Requests")],
      "gemini-flash-latest": [httpError(429, "Too Many Requests")],
    });
    await expect(fake.extractStructuredData("texto")).rejects.toBeInstanceOf(RateLimitError);
  });

  it("lanza RateLimitError con 429 y 503 mezclados: los dos son transitorios", async () => {
    const fake = new FakeGemini({
      "gemini-2.5-flash-lite": [httpError(429, "Too Many Requests")],
      "gemini-2.5-flash": [httpError(503, "Service Unavailable")],
      "gemini-flash-latest": [httpError(429, "Too Many Requests")],
    });
    await expect(fake.extractStructuredData("texto")).rejects.toBeInstanceOf(RateLimitError);
  });

  it("lanza Error normal si alguno falló por algo NO transitorio", async () => {
    const fake = new FakeGemini({
      "gemini-2.5-flash-lite": [httpError(503, "Service Unavailable")],
      "gemini-2.5-flash": [httpError(400, "Bad Request")],
      "gemini-flash-latest": [httpError(503, "Service Unavailable")],
    });
    // Se captura una sola vez: encadenar dos `expect().rejects` sobre la misma
    // promesa deja una rechazada sin manejar en el segundo await.
    const error = await fake.extractStructuredData("texto").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RateLimitError);
  });
});
```

- [ ] **Paso 2: Correr el test y verificar que falla**

```bash
npx vitest run src/services/geminiExtractor.service.test.ts
```

Esperado: FAIL en el primer y el tercer test — hoy `throwSweepFailure` exige que **todos** los
errores sean 429, así que con 503 lanza `Error` genérico.

- [ ] **Paso 3: Implementar**

Reemplazar `throwSweepFailure` en `src/services/geminiExtractor.service.ts`:

```ts
  /**
   * Si todos los intentos fallaron, decide qué lanzar.
   *
   * `RateLimitError` cuando TODOS los errores fueron transitorios — cuota
   * agotada (429) o servicio saturado (503) — porque el pipeline lo traduce a
   * "devolver la boleta a Pendientes" y reintentar en un ciclo posterior.
   *
   * El 503 se sumó el 2026-08-24: antes caía en el `Error` genérico y mandaba a
   * **Revisión** una boleta perfectamente sana por una caída de capacidad de
   * Google que dura minutos. Revisión es para lo que necesita ojo humano.
   */
  private throwSweepFailure(context: string, errors: string[]): never {
    const allTransient =
      errors.length > 0 &&
      errors.every((e) => isRateLimitError(e) || isTransientServerError(e));

    if (allTransient) {
      throw new RateLimitError(
        `${context}: los ${errors.length} modelo(s) del barrido fallaron por cuota o saturación (429/503)`
      );
    }
    throw new Error(`${context} failed for all candidate models. ${errors.join(" | ")}`);
  }
```

Y en `src/jobs/processPendingDocuments.job.ts`, línea 803, el mensaje deja de hablar solo de
cuota (el ruteo es por `instanceof`, así que el texto es solo para el log, pero un log que
miente cuesta una sesión de diagnóstico):

```ts
      throw new RateLimitError(`IA no disponible — ${aiFailures} proveedor(es) en 429/503`);
```

- [ ] **Paso 4: Correr el test y verificar que pasa**

```bash
npx vitest run src/services/geminiExtractor.service.test.ts
```

Esperado: PASS, 12 tests.

- [ ] **Paso 5: Verificar que ningún test dependía del mensaje viejo**

```bash
npx vitest run src/jobs/processPendingDocuments.job.test.ts
```

Esperado: PASS. Si algún test asertaba el string `"IA sin cuota"`, actualizarlo al texto nuevo
— el comportamiento no cambió, solo la redacción.

- [ ] **Paso 6: Checkpoint**

Dejar el árbol verde. No commitear.

---

## Tarea 6: El modelo pegajoso solo se fija tras un salto por cuota

**Files:**
- Modify: `src/services/geminiExtractor.service.ts`
- Test: `src/services/geminiExtractor.service.test.ts`

- [ ] **Paso 1: Escribir el test que falla**

Agregar a `src/services/geminiExtractor.service.test.ts`:

```ts
describe("GeminiExtractorService — modelo pegajoso", () => {
  it("fija el modelo cuando resuelve el primero, sin errores previos", async () => {
    const fake = new FakeGemini({ "gemini-2.5-flash-lite": [okResponse()] });
    await fake.extractStructuredData("CUIT 30-71497816-7 TOTAL 1000");
    expect(GeminiExtractorService.workingModel).toBe("gemini-2.5-flash-lite");
  });

  it("NO fija el modelo caro cuando el salto fue por 503", async () => {
    const fake = new FakeGemini({
      "gemini-2.5-flash-lite": [httpError(503, "Service Unavailable")],
      "gemini-2.5-flash": [okResponse()],
    });
    await fake.extractStructuredData("CUIT 30-71497816-7 TOTAL 1000");
    expect(GeminiExtractorService.workingModel).toBeNull();
  });

  it("SÍ fija el modelo cuando el salto fue por cuota (429)", async () => {
    const fake = new FakeGemini({
      "gemini-2.5-flash-lite": [httpError(429, "Too Many Requests")],
      "gemini-2.5-flash": [okResponse()],
    });
    await fake.extractStructuredData("CUIT 30-71497816-7 TOTAL 1000");
    expect(GeminiExtractorService.workingModel).toBe("gemini-2.5-flash");
  });

  it("tras un 503 la boleta siguiente vuelve a arrancar por flash-lite", async () => {
    const primera = new FakeGemini({
      "gemini-2.5-flash-lite": [httpError(503, "Service Unavailable")],
      "gemini-2.5-flash": [okResponse()],
    });
    await primera.extractStructuredData("CUIT 30-71497816-7 TOTAL 1000");

    const segunda = new FakeGemini({ "gemini-2.5-flash-lite": [okResponse()] });
    await segunda.extractStructuredData("CUIT 30-71497816-7 TOTAL 1000");
    expect(segunda.calls[0]).toBe("gemini-2.5-flash-lite");
  });
});
```

- [ ] **Paso 2: Correr el test y verificar que falla**

```bash
npx vitest run src/services/geminiExtractor.service.test.ts
```

Esperado: FAIL en el segundo y el cuarto test — hoy `workingModelName` se fija siempre que
haya éxito, sin mirar por qué se saltó.

- [ ] **Paso 3: Implementar**

Agregar el helper después de `throwSweepFailure` en
`src/services/geminiExtractor.service.ts`:

```ts
  /**
   * Fija el modelo pegajoso SOLO si el barrido no tuvo que saltar por un error
   * no-de-cuota.
   *
   * `workingModelName` es `static`: lo comparten todas las instancias del
   * proceso y no expira. Fijarlo tras un salto por 503 dejaba al worker clavado
   * en el modelo al que había saltado hasta el próximo reinicio — y si ese es
   * `2.5-flash`, son 3× el precio del input y 6× el del output de flash-lite,
   * sin que nada lo avise.
   *
   * Ante 429 el pegado SÍ corresponde: la cuota del modelo agotado no se
   * recupera para la boleta siguiente, así que volver a pegarle es gastar un
   * intento seguro al vacío. Esa es la razón por la que el pegado existe.
   */
  private static rememberWorkingModel(modelName: string, previousErrors: string[]): void {
    if (previousErrors.length > 0 && !previousErrors.every((e) => isRateLimitError(e))) return;
    GeminiExtractorService.workingModelName = modelName;
  }
```

Reemplazar las tres asignaciones directas de `workingModelName` por la llamada al helper.

En `extractStructuredData`:

```ts
        this.captureUsage(modelName, result);
        GeminiExtractorService.rememberWorkingModel(modelName, errors);
        return refined;
```

En `extractStructuredDataFromImage`, el mismo reemplazo (esa función ya tiene su array
`errors`).

En `extractPartiesFromImage` no hay array de errores: hay que agregarlo. El `catch` vacío
pasa a acumular, y la asignación pasa al helper:

```ts
    const errors: string[] = [];

    for (const modelName of this.buildModelCandidates()) {
      try {
        const result = await this.generateWithTransientRetry(modelName, {
          contents,
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        });
        const outputText = result.response.text() || "{}";
        const clean = outputText.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(clean) as {
          providerName?: string | null; providerTaxId?: string | null;
          consortiumName?: string | null; consortiumTaxId?: string | null;
        };
        this.captureUsage(modelName, result);
        GeminiExtractorService.rememberWorkingModel(modelName, errors);
        return {
          providerName: parsed.providerName ?? null,
          providerTaxId: parsed.providerTaxId ?? null,
          consortiumName: parsed.consortiumName ?? null,
          consortiumTaxId: parsed.consortiumTaxId ?? null,
        };
      } catch (error) {
        errors.push(`${modelName}: ${normalizeError(error)}`);
      }
    }
    return { providerName: null, providerTaxId: null, consortiumName: null, consortiumTaxId: null };
```

La línea `this.captureUsage(modelName, result);` de ese bloque es la Tarea 7 — se escribe acá
porque el bloque se reemplaza entero una sola vez, y su test va en la Tarea 7.

- [ ] **Paso 4: Correr el test y verificar que pasa**

```bash
npx vitest run src/services/geminiExtractor.service.test.ts
```

Esperado: PASS, 16 tests.

- [ ] **Paso 5: Checkpoint**

Dejar el árbol verde. No commitear.

---

## Tarea 7: El fallback visual registra sus tokens

**Files:**
- Modify: `src/services/geminiExtractor.service.ts` (ya editado en la Tarea 6)
- Test: `src/services/geminiExtractor.service.test.ts`

- [ ] **Paso 1: Escribir el test**

Agregar a `src/services/geminiExtractor.service.test.ts`:

```ts
describe("GeminiExtractorService — tokens del fallback visual", () => {
  const png = Buffer.from("fake-png-bytes");

  it("registra el consumo de extractPartiesFromImage", async () => {
    const fake = new FakeGemini({
      "gemini-2.5-flash-lite": [
        okResponse({ providerName: "PROVEEDOR SA", providerTaxId: "30-71497816-7" }),
      ],
    });
    await fake.extractPartiesFromImage(png);
    const usage = fake.getLastUsage();
    expect(usage).not.toBeNull();
    expect(usage!.provider).toBe("gemini");
    expect(usage!.model).toBe("gemini-2.5-flash-lite");
    expect(usage!.totalTokens).toBe(120);
  });

  it("devuelve el CUIT del emisor leído de la imagen", async () => {
    const fake = new FakeGemini({
      "gemini-2.5-flash-lite": [
        okResponse({ providerName: "PROVEEDOR SA", providerTaxId: "30-71497816-7" }),
      ],
    });
    const parties = await fake.extractPartiesFromImage(png);
    expect(parties.providerTaxId).toBe("30-71497816-7");
  });

  it("devuelve nulls sin lanzar cuando todos los modelos fallan", async () => {
    const fake = new FakeGemini({});
    const parties = await fake.extractPartiesFromImage(png);
    expect(parties).toEqual({
      providerName: null, providerTaxId: null,
      consortiumName: null, consortiumTaxId: null,
    });
  });
});
```

- [ ] **Paso 2: Correr el test y verificar el estado**

```bash
npx vitest run src/services/geminiExtractor.service.test.ts
```

Esperado: PASS los tres, porque la Tarea 6 ya insertó `this.captureUsage(modelName, result)`
en ese bloque. Si el primero falla con `usage` en `null`, esa línea no quedó — agregarla
antes de `rememberWorkingModel`.

- [ ] **Paso 3: Actualizar el comentario de la función**

El docstring de `extractPartiesFromImage` dice "Barre modelos; si todos fallan devuelve null
sin lanzar". Agregarle:

```
   * Registra el consumo en `lastUsage` (2026-08-24): era el único camino que
   * gastaba tokens sin dejar rastro en `TokenUsage`, así que el consumo real de
   * la cuenta quedaba subestimado.
```

- [ ] **Paso 4: Checkpoint**

Dejar el árbol verde. No commitear.

---

## Tarea 8: Verificación completa y documentación

**Files:**
- Modify: `docs/progreso.md`
- Modify: `docs/decisiones.md`
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`

- [ ] **Paso 1: Suite completa**

```bash
npx vitest run
```

Esperado: PASS. Baseline antes de esta entrega: 717 tests. Nuevos: 8 (Tarea 1) + 1 (Tarea 2,
el test de Groq) + 19 en `geminiExtractor.service.test.ts` (3 + 5 + 4 + 4 + 3 de las Tareas
3 a 7) = **745**.

- [ ] **Paso 2: Typecheck**

```bash
npm run typecheck
```

Esperado: 0 errores.

- [ ] **Paso 3: Lint**

```bash
npm run lint
```

Esperado: 0 errores.

- [ ] **Paso 4: Build de la app**

```bash
npm run build
```

Esperado: OK.

- [ ] **Paso 5: Build de los jobs**

```bash
npm run build:jobs
```

Esperado: OK.

- [ ] **Paso 6: Actualizar `CLAUDE.md`**

Dos lugares dicen el orden viejo de la cadena:

1. En "Descripción del proyecto": `cadena de fallback **Cerebras → Gemini → OpenAI → Claude**`
   pasa a `**Gemini → Cerebras → OpenAI → Claude**`.
2. En el paso 4 del pipeline: `Resto: cadena Cerebras → Gemini → OpenAI → Claude` pasa a
   `Resto: cadena Gemini → Cerebras → OpenAI → Claude`.

- [ ] **Paso 7: Actualizar `docs/progreso.md`**

Sección nueva arriba de todo, con el formato de las existentes: estado (implementado y
verificado, tests, sin migración, sin commitear), origen, qué se hizo por pieza, la medición
de `TokenUsage` que justificó la entrega, y el **⏳ Pendiente del owner**: instalar poppler,
armar el lote fijo, correr el testbench con la key free y con la paga, y recién después pegar
la key paga en el panel.

- [ ] **Paso 8: Actualizar `docs/decisiones.md`**

Entrada con fecha 2026-08-24 documentando las decisiones que no se leen del código:

- Por qué Gemini pasa a primero (medición: 77% de las boletas ya las resolvía yendo segundo;
  Cerebras devolviendo 402).
- Por qué el barrido se acorta en vez de eliminarse (el 503 no desaparece en tier pago).
- Por qué no se reusó `callWithRetry` (su contrato termina en `RateLimitError`, el 503
  necesita degradar de modelo).
- Por qué el pegado del modelo pasa a depender del tipo de error, y no a expirar por tiempo
  (evita meter el reloj en el estado y en los tests).
- Por qué NO se agregó `providerOrder` configurable ni el flag `geminiTier`.

- [ ] **Paso 9: Actualizar `CHANGELOG.md`**

Entrada con fecha 2026-08-24 y los highlights de la sesión.

- [ ] **Paso 10: Checkpoint final**

Avisar al owner: "listo para commitear", con el resumen de archivos tocados y el conteo de
tests.

---

## Lo que este plan NO hace

- **No instala poppler.** Es acción del owner (spec, sección 5.2). Sin eso el testbench no
  puede probar boletas escaneadas ni de membrete en imagen.
- **No arma el lote fijo de regresión.** Los PDFs y sus `expected.json` los junta el owner
  (spec, sección 5.3).
- **No cambia la key de Gemini en producción.** Se pega en el panel del cliente cuando el
  owner decida, después de comparar los dos reportes del testbench.
- **No toca Cerebras.** Queda segundo en la cadena. El 402 por cuota agotada se trata aparte.
