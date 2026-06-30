# Más cuota de IA gratis (Cerebras + Groq) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **⚠️ REGLA DEL OWNER (sobrescribe el flujo por defecto de la skill):** Claude **NUNCA** ejecuta `git commit` ni `git push`. Se trabaja siempre directo en `master`, sin ramas. El paso final de cada tarea es un **checkpoint** (correr la verificación y dejar el working tree listo); **el owner commitea cuando quiera**. Donde un plan normal diría "Commit", acá se corre la verificación y se avisa.

**Goal:** Subir el techo diario de procesamiento de boletas de ~100/día a varios cientos/día, 100% gratis, sumando Cerebras y Groq (free tier propio) a la cadena de extracción IA del pipeline automático.

**Architecture:** Un extractor genérico `OpenAICompatibleExtractorService` (Cerebras y Groq hablan la Chat Completions API de OpenAI) que implementa el contrato `AiExtractor` existente. Se suma a `createAiExtractionChain` **antes** de Gemini (orden capacidad-primero: `Cerebras → Groq → Gemini → OpenAI → Claude`). Keys por env global (sin migración, sin UI). El scan manual NO se toca. Un script comparador valida la calidad de Llama contra Gemini sobre PDFs reales antes de activar en prod.

**Tech Stack:** TypeScript, SDK `openai` (ya instalado, reutilizado con `baseURL`), Vitest, Zod (schema de extracción existente).

**Spec:** `docs/superpowers/specs/2026-06-24-cuota-ia-gratis-cerebras-groq-design.md`

> **Actualización post-validación (25/06):** el default de Cerebras es **`gpt-oss-120b`**, no
> `llama-3.3-70b`. Cerebras retiró los modelos Llama de su catálogo free (quedan `gpt-oss-120b` y
> `zai-glm-4.7`), así que `llama-3.3-70b` daba 404. Donde abajo se lea `llama-3.3-70b` para
> **Cerebras**, va `gpt-oss-120b`. Groq sigue en `llama-3.3-70b-versatile`. Validado con un F931
> real: ambos extraen el monto correcto.

---

## File Structure

| Archivo | Responsabilidad | Acción |
|---|---|---|
| `src/types/aiUsage.types.ts` | Union `AiProvider` | Modificar: `+ "cerebras" \| "groq"` |
| `src/services/openAICompatibleExtractor.service.ts` | Extractor genérico Chat-Completions (Cerebras/Groq) | **Crear** |
| `src/services/openAICompatibleExtractor.service.test.ts` | Test del extractor genérico | **Crear** |
| `src/lib/aiErrors.ts` | Clasificación de rate-limit | Modificar: reconocer `status === 429` |
| `src/lib/aiErrors.test.ts` | Tests de `isRateLimitError` | Modificar: casos de status 429 |
| `src/services/aiExtraction.ts` | Cadena de extractores + factory | Modificar: config `cerebras`/`groq`, orden, getter `providerOrder` |
| `src/services/aiExtraction.test.ts` | Tests de la cadena | Modificar: test de orden |
| `src/config/env.ts` | Carga de env vars | Modificar: 4 vars nuevas |
| `src/jobs/processPendingDocuments.job.ts` | Pipeline (config + contexto) | Modificar: wiring cerebras/groq |
| `scripts/compare-extractors.ts` | Comparador de calidad multi-proveedor | **Crear** |
| `docs/progreso.md`, `docs/decisiones.md`, `CHANGELOG.md` | Documentación obligatoria | Modificar |

---

## Task 1: Tipo `AiProvider` + extractor genérico OpenAI-compatible

**Files:**
- Modify: `src/types/aiUsage.types.ts:1`
- Create: `src/services/openAICompatibleExtractor.service.ts`
- Test: `src/services/openAICompatibleExtractor.service.test.ts`

- [ ] **Step 1: Ampliar el union `AiProvider`**

En `src/types/aiUsage.types.ts`, línea 1, reemplazar:

```typescript
export type AiProvider = "gemini" | "openai" | "anthropic";
```

por:

```typescript
export type AiProvider = "gemini" | "openai" | "anthropic" | "cerebras" | "groq";
```

- [ ] **Step 2: Escribir el test del extractor genérico (falla)**

Crear `src/services/openAICompatibleExtractor.service.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  OpenAICompatibleExtractorService,
  type ChatCompleteFn,
} from "@/services/openAICompatibleExtractor.service";

function fakeComplete(content: string, usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }): { fn: ChatCompleteFn; calls: unknown[] } {
  const calls: unknown[] = [];
  const fn: ChatCompleteFn = async (params) => {
    calls.push(params);
    return { choices: [{ message: { content } }], usage };
  };
  return { fn, calls };
}

describe("OpenAICompatibleExtractorService", () => {
  it("expone el provider configurado", () => {
    const { fn } = fakeComplete("{}");
    const svc = new OpenAICompatibleExtractorService({
      provider: "cerebras", apiKey: "x", baseURL: "https://api.cerebras.ai/v1", model: "llama-3.3-70b", complete: fn,
    });
    expect(svc.provider).toBe("cerebras");
  });

  it("parsea el JSON de la respuesta y mapea el usage al provider correcto", async () => {
    const content = JSON.stringify({ provider: "ACME S.A.", consortium: "TEST 123", amount: 1000 });
    const { fn, calls } = fakeComplete(content, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
    const svc = new OpenAICompatibleExtractorService({
      provider: "groq", apiKey: "x", baseURL: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", complete: fn,
    });

    const data = await svc.extractStructuredData("texto de prueba sin marcadores");

    expect(data.provider).toBe("ACME S.A.");
    expect(data.consortium).toBe("TEST 123");
    expect(data.amount).toBe(1000);

    const usage = svc.getLastUsage();
    expect(usage).toEqual({ provider: "groq", model: "llama-3.3-70b-versatile", inputTokens: 100, outputTokens: 20, totalTokens: 120 });

    // Se pidió JSON mode y el modelo correcto.
    expect(calls[0]).toMatchObject({
      model: "llama-3.3-70b-versatile",
      temperature: 0,
      response_format: { type: "json_object" },
    });
  });

  it("usa {} cuando el modelo no devuelve content (sin romper)", async () => {
    const { fn } = fakeComplete("");
    const svc = new OpenAICompatibleExtractorService({
      provider: "cerebras", apiKey: "x", baseURL: "https://api.cerebras.ai/v1", model: "llama-3.3-70b", complete: fn,
    });
    const data = await svc.extractStructuredData("hola");
    expect(data.provider).toBeNull();
    expect(data.amount).toBeNull();
  });

  it("lanza si el texto de entrada está vacío", async () => {
    const { fn } = fakeComplete("{}");
    const svc = new OpenAICompatibleExtractorService({
      provider: "groq", apiKey: "x", baseURL: "https://api.groq.com/openai/v1", model: "m", complete: fn,
    });
    await expect(svc.extractStructuredData("   ")).rejects.toThrow(/No text/);
  });
});
```

- [ ] **Step 3: Correr el test y verificar que falla**

Run: `npx vitest run src/services/openAICompatibleExtractor.service.test.ts`
Expected: FAIL — `Cannot find module '@/services/openAICompatibleExtractor.service'`.

- [ ] **Step 4: Implementar el extractor genérico**

Crear `src/services/openAICompatibleExtractor.service.ts`:

```typescript
import OpenAI from "openai";
import {
  buildExtractionPrompt,
  parseExtractionOutput,
  refineExtractionWithRawText,
} from "@/lib/extraction";
import { AiUsageMetrics, AiProvider } from "@/types/aiUsage.types";
import { AiExtractor } from "@/services/aiExtraction";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";

/**
 * Extractor genérico para proveedores con API compatible con la Chat Completions
 * de OpenAI (Cerebras, Groq, y a futuro Mistral/OpenRouter/DeepInfra). Reutiliza
 * el SDK `openai` cambiando `baseURL`, y el mismo prompt/parseo/refinamiento que
 * los demás extractores, de modo que la cadena los trata de forma intercambiable.
 *
 * El llamado al modelo se inyecta como `complete` (seam testeable, igual que los
 * seams del pipeline): en prod usa el SDK real; en tests se pasa un fake.
 */
export interface ChatCompletionParams {
  model: string;
  temperature: number;
  response_format: { type: "json_object" };
  messages: { role: "user"; content: string }[];
}

export interface ChatCompletionResponse {
  choices: { message: { content: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export type ChatCompleteFn = (params: ChatCompletionParams) => Promise<ChatCompletionResponse>;

export interface OpenAICompatibleOptions {
  provider: AiProvider;
  apiKey: string;
  baseURL: string;
  model: string;
  /** Seam para tests; en prod se usa el SDK de OpenAI contra `baseURL`. */
  complete?: ChatCompleteFn;
}

export class OpenAICompatibleExtractorService implements AiExtractor {
  readonly provider: AiProvider;
  private readonly model: string;
  private readonly complete: ChatCompleteFn;
  private lastUsage: AiUsageMetrics | null = null;

  constructor(options: OpenAICompatibleOptions) {
    if (!options.apiKey?.trim()) {
      throw new Error(`API key is required for ${options.provider} extractor`);
    }
    this.provider = options.provider;
    this.model = options.model;

    if (options.complete) {
      this.complete = options.complete;
    } else {
      const client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL });
      this.complete = (params) =>
        client.chat.completions.create(params) as unknown as Promise<ChatCompletionResponse>;
    }
  }

  async extractStructuredData(text: string): Promise<ExtractedDocumentData> {
    if (!text.trim()) {
      throw new Error(`No text provided for ${this.provider} extraction`);
    }
    this.lastUsage = null;
    const prompt = buildExtractionPrompt(text);

    const response = await this.complete({
      model: this.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    });

    const outputText = response.choices[0]?.message?.content || "{}";
    const parsed = parseExtractionOutput(outputText);

    const usage = response.usage;
    const inputTokens = Number(usage?.prompt_tokens ?? 0);
    const outputTokens = Number(usage?.completion_tokens ?? 0);
    const totalTokens = Number(usage?.total_tokens ?? inputTokens + outputTokens);
    this.lastUsage = {
      provider: this.provider,
      model: this.model,
      inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
      outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
      totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
    };

    return refineExtractionWithRawText(parsed, text);
  }

  getLastUsage(): AiUsageMetrics | null {
    return this.lastUsage;
  }
}
```

- [ ] **Step 5: Correr el test y verificar que pasa**

Run: `npx vitest run src/services/openAICompatibleExtractor.service.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Checkpoint**

Run: `npx tsc --noEmit`
Expected: sin errores. Avisar al owner: Task 1 lista para commitear (no ejecutar `git commit`).

---

## Task 2: `isRateLimitError` reconoce el `status === 429` del SDK de OpenAI

**Files:**
- Modify: `src/lib/aiErrors.ts:23-40`
- Test: `src/lib/aiErrors.test.ts`

**Por qué:** el SDK de OpenAI (usado por OpenAI, Cerebras y Groq) lanza `APIError` con `status` numérico, y los mensajes de Cerebras/Groq pueden no contener literalmente "429"/"quota". Sin esto, un 429 de los nuevos proveedores se clasificaría como fallo genérico → la boleta degradaría a OCR_ONLY → Revisión en vez de volver a Pendientes (rompe el circuit breaker de cuota).

- [ ] **Step 1: Escribir los tests nuevos (fallan)**

En `src/lib/aiErrors.test.ts`, dentro del `describe("isRateLimitError", ...)`, agregar después del test "acepta strings además de Error" (línea ~31):

```typescript
  it("detecta el APIError del SDK de OpenAI por status 429 (Cerebras/Groq)", () => {
    // El SDK no garantiza '429' en el message; el status numérico es la señal fiable.
    expect(isRateLimitError({ status: 429, message: "Rate limit reached for model" })).toBe(true);
  });

  it("detecta el code rate_limit_exceeded del SDK de OpenAI", () => {
    expect(isRateLimitError({ code: "rate_limit_exceeded", message: "slow down" })).toBe(true);
  });

  it("NO clasifica como rate-limit un error con status 500", () => {
    expect(isRateLimitError({ status: 500, message: "internal error" })).toBe(false);
  });
```

- [ ] **Step 2: Correr y verificar que fallan**

Run: `npx vitest run src/lib/aiErrors.test.ts`
Expected: FAIL en los dos primeros nuevos (un objeto plano no matchea el texto actual).

- [ ] **Step 3: Implementar la detección por status/code**

En `src/lib/aiErrors.ts`, reemplazar la función `isRateLimitError` (líneas 23-40) por:

```typescript
export function isRateLimitError(error: unknown): boolean {
  if (error instanceof RateLimitError) return true;
  if (error === null || error === undefined) return false;

  // El SDK de OpenAI (OpenAI/Cerebras/Groq) lanza APIError con `status` numérico
  // y/o `code`. Cerebras/Groq pueden no incluir "429" en el mensaje, así que el
  // status es la señal fiable.
  if (typeof error === "object") {
    const e = error as { status?: unknown; code?: unknown };
    if (e.status === 429) return true;
    if (e.code === "rate_limit_exceeded" || e.code === "insufficient_quota") return true;
  }

  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();

  return (
    /\b429\b/.test(text) ||
    text.includes("too many requests") ||
    text.includes("resource_exhausted") ||
    text.includes("quota") ||
    // Mensajes propios en español (p. ej. el RateLimitError del barrido de
    // modelos: "sin cuota en los N modelo(s)"). La cadena de IA propaga el
    // MENSAJE (string) al pipeline, así que el matcher debe reconocerlos.
    text.includes("sin cuota") ||
    text.includes("cuota agotada")
  );
}
```

- [ ] **Step 4: Correr toda la suite de aiErrors y verificar que pasa**

Run: `npx vitest run src/lib/aiErrors.test.ts`
Expected: PASS (todos, incluidos los 3 nuevos). Verificar que sigue dando `false` para `{ status: 500 }` y para strings normales.

- [ ] **Step 5: Checkpoint**

Run: `npx tsc --noEmit`
Expected: sin errores. Avisar: Task 2 lista para commitear.

---

## Task 3: Sumar Cerebras + Groq a la cadena (orden capacidad-primero) + getter `providerOrder`

**Files:**
- Modify: `src/services/aiExtraction.ts:30-34` (config), `:65-96` (clase), `:103-130` (factory)
- Test: `src/services/aiExtraction.test.ts`

- [ ] **Step 1: Escribir los tests de orden (fallan)**

En `src/services/aiExtraction.test.ts`, agregar al final del archivo:

```typescript
import { createAiExtractionChain } from "@/services/aiExtraction";

describe("createAiExtractionChain — orden capacidad-primero", () => {
  it("ordena Cerebras → Groq → Gemini → OpenAI cuando todos tienen key", async () => {
    const chain = await createAiExtractionChain({
      cerebras: { apiKey: "x", model: "llama-3.3-70b" },
      groq: { apiKey: "x", model: "llama-3.3-70b-versatile" },
      gemini: { apiKey: "x" },
      openai: { apiKey: "x" },
    });
    expect(chain.providerOrder).toEqual(["cerebras", "groq", "gemini", "openai"]);
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

- [ ] **Step 2: Correr y verificar que fallan**

Run: `npx vitest run src/services/aiExtraction.test.ts`
Expected: FAIL — `providerOrder` no existe y la config no acepta `cerebras`/`groq`.

- [ ] **Step 3: Agregar `cerebras`/`groq` a la config y el getter `providerOrder`**

En `src/services/aiExtraction.ts`, en la interfaz `AiExtractionChainConfig` (líneas 30-34), agregar los dos campos **antes** de `gemini`:

```typescript
export interface AiExtractionChainConfig {
  cerebras?: AiProviderCredentials;
  groq?: AiProviderCredentials;
  gemini?: AiProviderCredentials;
  openai?: AiProviderCredentials;
  anthropic?: AiProviderCredentials;
}
```

En la clase `AiExtractionChain`, agregar el getter junto a `providerCount` (después de la línea `get providerCount()`):

```typescript
  /** Orden de fallback de los proveedores (para tests y diagnóstico). */
  get providerOrder(): AiProvider[] {
    return this.extractors.map((e) => e.provider);
  }
```

Asegurar que `AiProvider` esté importado en el archivo. La línea 2 ya importa de `@/types/aiUsage.types`; dejarla como:

```typescript
import { AiProvider, AiUsageMetrics } from "@/types/aiUsage.types";
```

- [ ] **Step 4: Pushear Cerebras y Groq antes de Gemini en el factory**

En `createAiExtractionChain` (línea 106, justo después de `const extractors: AiExtractor[] = [];` y **antes** del bloque `if (config.gemini?.apiKey)`), insertar:

```typescript
  if (config.cerebras?.apiKey) {
    const { OpenAICompatibleExtractorService } = await import("@/services/openAICompatibleExtractor.service");
    extractors.push(
      new OpenAICompatibleExtractorService({
        provider: "cerebras",
        apiKey: config.cerebras.apiKey,
        baseURL: "https://api.cerebras.ai/v1",
        model: config.cerebras.model?.trim() || "llama-3.3-70b",
      })
    );
  }

  if (config.groq?.apiKey) {
    const { OpenAICompatibleExtractorService } = await import("@/services/openAICompatibleExtractor.service");
    extractors.push(
      new OpenAICompatibleExtractorService({
        provider: "groq",
        apiKey: config.groq.apiKey,
        baseURL: "https://api.groq.com/openai/v1",
        model: config.groq.model?.trim() || "llama-3.3-70b-versatile",
      })
    );
  }
```

Actualizar el comentario del JSDoc de la función (línea ~101) para reflejar el orden nuevo:

```typescript
 * que ya tenía el pipeline). Orden de fallback: Cerebras → Groq → Gemini → OpenAI → Claude.
```

- [ ] **Step 5: Correr el test y verificar que pasa**

Run: `npx vitest run src/services/aiExtraction.test.ts`
Expected: PASS (los tests previos + los 2 nuevos de orden).

> Nota: crear `new OpenAICompatibleExtractorService(...)` y `new GeminiExtractorService(...)` con keys dummy NO hace requests (los SDKs son lazy), así que el test es seguro sin red.

- [ ] **Step 6: Checkpoint**

Run: `npx tsc --noEmit`
Expected: sin errores. Avisar: Task 3 lista para commitear.

---

## Task 4: Variables de entorno para Cerebras y Groq

**Files:**
- Modify: `src/config/env.ts:10-29` (interfaz), `:52-71` (objeto)

- [ ] **Step 1: Agregar los campos a `EnvConfig`**

En `src/config/env.ts`, dentro de `interface EnvConfig`, agregar después de `ANTHROPIC_MODEL?: string;` (línea 25):

```typescript
  CEREBRAS_API_KEY?: string;
  CEREBRAS_MODEL?: string;
  GROQ_API_KEY?: string;
  GROQ_MODEL?: string;
```

- [ ] **Step 2: Cargar los valores en el objeto `env`**

En el objeto `env`, agregar después de `ANTHROPIC_MODEL: optionalEnv("ANTHROPIC_MODEL"),` (línea 67):

```typescript
  CEREBRAS_API_KEY: optionalEnv("CEREBRAS_API_KEY"),
  CEREBRAS_MODEL: optionalEnv("CEREBRAS_MODEL"),
  GROQ_API_KEY: optionalEnv("GROQ_API_KEY"),
  GROQ_MODEL: optionalEnv("GROQ_MODEL"),
```

- [ ] **Step 3: Verificar typecheck**

Run: `npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 4: Checkpoint**

Avisar: Task 4 lista para commitear. (Sin test: es carga de configuración; la verificación es el typecheck.)

> **Nota para el owner (no es paso de código):** `docker-compose.yml` ya usa `env_file: .env` en `web`/`scheduler`/`worker`, así que basta con agregar `CEREBRAS_API_KEY` y `GROQ_API_KEY` (y opcionalmente `CEREBRAS_MODEL`/`GROQ_MODEL`) al archivo `.env` del servidor. No hay que tocar el compose.

---

## Task 5: Wiring en el pipeline automático (`processPendingDocuments.job.ts`)

**Files:**
- Modify: `src/jobs/processPendingDocuments.job.ts:41-48` (ProcessJobConfig.aiConfig), `:199-210` (createProcessingContext)

**Recordatorio:** el scan manual (`.../invoices/scan/route.ts`) **NO se toca** (decisión del owner).

- [ ] **Step 1: Ampliar `ProcessJobConfig.aiConfig`**

En `src/jobs/processPendingDocuments.job.ts`, dentro de `aiConfig` (líneas 41-48), agregar los 4 campos:

```typescript
  aiConfig?: {
    cerebrasApiKey?: string;
    cerebrasModel?: string;
    groqApiKey?: string;
    groqModel?: string;
    geminiApiKey?: string;
    geminiModel?: string;
    openaiApiKey?: string;
    openaiModel?: string;
    anthropicApiKey?: string;
    anthropicModel?: string;
  } | null;
```

- [ ] **Step 2: Resolver las keys y pasarlas a la cadena**

En `createProcessingContext`, reemplazar el bloque (líneas 199-210):

```typescript
  const geminiApiKey = config.aiConfig?.geminiApiKey?.trim() || env.GEMINI_API_KEY?.trim();
  const openaiApiKey = config.aiConfig?.openaiApiKey?.trim() || env.OPENAI_API_KEY?.trim();
  const anthropicApiKey = config.aiConfig?.anthropicApiKey?.trim() || env.ANTHROPIC_API_KEY?.trim();
  const geminiModel = config.aiConfig?.geminiModel?.trim() || env.GEMINI_MODEL;
  const openaiModel = config.aiConfig?.openaiModel?.trim() || env.OPENAI_MODEL;
  const anthropicModel = config.aiConfig?.anthropicModel?.trim() || env.ANTHROPIC_MODEL;
  const geminiModule = geminiApiKey ? await import("@/services/geminiExtractor.service") : null;
  const aiChain = await createAiExtractionChain({
    gemini: { apiKey: geminiApiKey, model: geminiModel },
    openai: { apiKey: openaiApiKey, model: openaiModel },
    anthropic: { apiKey: anthropicApiKey, model: anthropicModel },
  });
```

por:

```typescript
  const cerebrasApiKey = config.aiConfig?.cerebrasApiKey?.trim() || env.CEREBRAS_API_KEY?.trim();
  const groqApiKey = config.aiConfig?.groqApiKey?.trim() || env.GROQ_API_KEY?.trim();
  const geminiApiKey = config.aiConfig?.geminiApiKey?.trim() || env.GEMINI_API_KEY?.trim();
  const openaiApiKey = config.aiConfig?.openaiApiKey?.trim() || env.OPENAI_API_KEY?.trim();
  const anthropicApiKey = config.aiConfig?.anthropicApiKey?.trim() || env.ANTHROPIC_API_KEY?.trim();
  const cerebrasModel = config.aiConfig?.cerebrasModel?.trim() || env.CEREBRAS_MODEL;
  const groqModel = config.aiConfig?.groqModel?.trim() || env.GROQ_MODEL;
  const geminiModel = config.aiConfig?.geminiModel?.trim() || env.GEMINI_MODEL;
  const openaiModel = config.aiConfig?.openaiModel?.trim() || env.OPENAI_MODEL;
  const anthropicModel = config.aiConfig?.anthropicModel?.trim() || env.ANTHROPIC_MODEL;
  const geminiModule = geminiApiKey ? await import("@/services/geminiExtractor.service") : null;
  const aiChain = await createAiExtractionChain({
    cerebras: { apiKey: cerebrasApiKey, model: cerebrasModel },
    groq: { apiKey: groqApiKey, model: groqModel },
    gemini: { apiKey: geminiApiKey, model: geminiModel },
    openai: { apiKey: openaiApiKey, model: openaiModel },
    anthropic: { apiKey: anthropicApiKey, model: anthropicModel },
  });
```

> El módulo Gemini (`geminiModule`) se mantiene aparte porque la extracción Vision y el fallback visual del emisor no son parte de la cadena de texto. No cambia.

- [ ] **Step 3: Correr los tests de caracterización del pipeline (deben seguir verdes)**

Run: `npx vitest run src/jobs/processPendingDocuments.job.test.ts`
Expected: PASS — todos los tests de caracterización siguen verdes. Sin keys de cerebras/groq en el entorno de test, esos eslabones no se agregan → comportamiento idéntico al actual.

- [ ] **Step 4: Verificar typecheck + build de jobs**

Run: `npx tsc --noEmit`
Run: `npm run build:jobs`
Expected: ambos sin errores.

- [ ] **Step 5: Checkpoint**

Avisar: Task 5 lista para commitear.

---

## Task 6: Script comparador de calidad (`scripts/compare-extractors.ts`)

**Files:**
- Create: `scripts/compare-extractors.ts`

**Por qué:** gate de validación previo a confiar el primer lugar de la cadena a Llama. Corre cada proveedor sobre el mismo texto de PDFs reales y muestra los campos lado a lado. Solo lectura, sin DB ni Sheets.

- [ ] **Step 1: Crear el script**

Crear `scripts/compare-extractors.ts`:

```typescript
/**
 * Comparador de extractores IA sobre PDFs reales (gate de calidad).
 *
 * Para cada PDF: extrae el texto con el extractor del pipeline y corre CADA
 * proveedor configurado (Cerebras, Groq, Gemini, OpenAI) sobre el MISMO texto,
 * mostrando los campos clave lado a lado. No escribe en DB ni Sheets.
 *
 * Uso:
 *   npx tsx scripts/compare-extractors.ts <ruta.pdf> [<ruta2.pdf> ...]
 *
 * Requiere al menos una key en el entorno: CEREBRAS_API_KEY / GROQ_API_KEY /
 * GEMINI_API_KEY / OPENAI_API_KEY (con sus *_MODEL opcionales).
 */
import { readFileSync } from "fs";
import { loadEnv } from "@/lib/loadEnv";
import { PdfTextExtractorService } from "@/services/pdfTextExtractor.service";
import { identifyLSPProvider } from "@/lib/extraction";
import type { AiExtractor } from "@/services/aiExtraction";

loadEnv();

async function buildExtractors(): Promise<AiExtractor[]> {
  const list: AiExtractor[] = [];
  const { OpenAICompatibleExtractorService } = await import("@/services/openAICompatibleExtractor.service");

  if (process.env.CEREBRAS_API_KEY) {
    list.push(new OpenAICompatibleExtractorService({
      provider: "cerebras", apiKey: process.env.CEREBRAS_API_KEY,
      baseURL: "https://api.cerebras.ai/v1", model: process.env.CEREBRAS_MODEL || "llama-3.3-70b",
    }));
  }
  if (process.env.GROQ_API_KEY) {
    list.push(new OpenAICompatibleExtractorService({
      provider: "groq", apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1", model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    }));
  }
  if (process.env.GEMINI_API_KEY) {
    const { GeminiExtractorService } = await import("@/services/geminiExtractor.service");
    list.push(new GeminiExtractorService({ apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL }));
  }
  if (process.env.OPENAI_API_KEY) {
    const { AiExtractorService } = await import("@/services/aiExtractor.service");
    list.push(new AiExtractorService({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL }));
  }
  return list;
}

const pdfPaths = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (pdfPaths.length === 0) {
  console.error("Uso: npx tsx scripts/compare-extractors.ts <ruta.pdf> [<ruta2.pdf> ...]");
  process.exit(1);
}

async function main() {
  const extractors = await buildExtractors();
  if (extractors.length === 0) {
    console.error("No hay extractores configurados. Definí al menos una de: CEREBRAS_API_KEY, GROQ_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY.");
    process.exit(1);
  }
  console.log(`Proveedores: ${extractors.map((e) => e.provider).join(", ")}`);

  const pdfExtractor = new PdfTextExtractorService();
  for (const path of pdfPaths) {
    const buffer = readFileSync(path);
    const text = await pdfExtractor.extractTextFromPdf(buffer);
    console.log(`\n══════ ${path} ══════`);
    console.log(`router: ${identifyLSPProvider(text) ?? "factura común"} · ${text.length} chars · fuente=${pdfExtractor.getLastTextSource()}`);

    for (const ex of extractors) {
      const t0 = Date.now();
      try {
        const d = await ex.extractStructuredData(text);
        const u = ex.getLastUsage();
        console.log(`\n[${ex.provider}] ${u?.model ?? ""} — ${Date.now() - t0}ms · tokens=${u?.totalTokens ?? "?"}`);
        console.log(`  consorcio:   ${d.consortium ?? "—"}`);
        console.log(`  proveedor:   ${d.provider ?? "—"}`);
        console.log(`  CUIT prov:   ${d.providerTaxId ?? "—"}`);
        console.log(`  monto:       ${d.amount ?? "—"}`);
        console.log(`  vencimiento: ${d.dueDate ?? "—"}`);
        console.log(`  N° boleta:   ${d.boletaNumber ?? "—"}`);
      } catch (e) {
        console.log(`\n[${ex.provider}] ERROR: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Verificar que typechequea y muestra el uso sin argumentos**

Run: `npx tsc --noEmit`
Expected: sin errores.

Run: `npx tsx scripts/compare-extractors.ts`
Expected: imprime "Uso: npx tsx scripts/compare-extractors.ts <ruta.pdf> ..." y sale con código 1.

- [ ] **Step 3: Checkpoint**

Avisar: Task 6 lista para commitear.

---

## Task 7: Verificación completa + documentación obligatoria

**Files:**
- Modify: `docs/progreso.md`, `docs/decisiones.md`, `CHANGELOG.md`

- [ ] **Step 1: Correr toda la suite de verificación**

Run: `npm test`
Run: `npm run typecheck`
Run: `npm run lint`
Run: `npm run build:jobs`
Expected: todo verde. La suite incluye los tests nuevos (extractor genérico, status 429, orden de cadena) y mantiene verdes los de caracterización del pipeline.

- [ ] **Step 2: Actualizar `docs/progreso.md`**

Agregar una entrada al principio (debajo del encabezado) describiendo: el problema del techo de cuota, la solución (Cerebras + Groq al frente de la cadena, gratis), el orden, el gate de validación con `compare-extractors.ts`, y el estado (implementado + verificado; PENDIENTE owner: cargar keys en `.env`, correr el comparador con PDFs reales, y deployar worker+web si la calidad es buena). Marcar que el scan manual no se tocó.

- [ ] **Step 3: Actualizar `docs/decisiones.md`**

Agregar una entrada `## 2026-06-24 — Más cuota de IA gratis: Cerebras + Groq en la cadena` con: Problema (techo diario de Gemini, restricción 100% gratis), Decisión (extractor genérico OpenAI-compatible, orden capacidad-primero, keys por env, scan manual intacto, ajuste de `isRateLimitError` por status 429), Alternativas descartadas (parser determinístico — predominan variadas; rotación de keys Gemini — ToS; OpenRouter — requiere US$10; tier pago — el owner lo descartó), e Impacto (archivos + tests + sin migración). Citar los free tiers verificados (Cerebras 1M tokens/día, Groq 1.000/14.400 req/día).

- [ ] **Step 4: Actualizar `CHANGELOG.md`**

Agregar entrada fechada 2026-06-24 con los highlights: extractor genérico Cerebras/Groq, cadena reordenada (capacidad primero), `isRateLimitError` por status 429, script `compare-extractors.ts`, env nuevas. Sin migración.

- [ ] **Step 5: Checkpoint final**

Run: `npm test` (confirmación final tras editar docs — las docs no afectan tests, pero cierra el ciclo).
Expected: verde. Avisar al owner: implementación completa, lista para commitear; siguen los pasos operativos del owner (abajo).

---

## Pasos operativos del owner (post-implementación, fuera del código)

1. Obtener API keys gratis (sin tarjeta): **Cerebras** (`cloud.cerebras.ai`) y **Groq** (`console.groq.com`).
2. Agregarlas al `.env` del servidor: `CEREBRAS_API_KEY=...`, `GROQ_API_KEY=...` (opcional `CEREBRAS_MODEL` / `GROQ_MODEL`).
3. **Validar calidad** con PDFs reales de facturas variadas:
   `npx tsx scripts/compare-extractors.ts ./algunas-facturas/*.pdf`
   Comparar que Cerebras/Groq (Llama) extraen igual que Gemini en consorcio/proveedor/CUIT/monto/vencimiento.
4. Si la calidad es buena → rebuild de `worker` y `web` (el `web` solo por consistencia; el scan manual no usa los nuevos). El scheduler no cambia.
5. Observar el throughput del día siguiente: debería superar holgadamente el techo previo, sin pausas por cuota (`⏸️ Cuota IA agotada`).

---

## Self-Review (completado por el autor del plan)

- **Cobertura del spec:** §6.1 extractor genérico → Task 1; §6.3 + §7 `isRateLimitError` → Task 2; §6.2 cadena reordenada + getter → Task 3; §8 env → Task 4; §7 wiring pipeline (scan excluido) → Task 5; §9 comparador → Task 6; §14 verificación + docs → Task 7. Sin gaps.
- **Placeholders:** ninguno; todo el código está completo y los comandos tienen output esperado.
- **Consistencia de tipos:** `AiProvider` (Task 1) se usa en `providerOrder`/config (Task 3) y en el extractor; `ChatCompleteFn`/`ChatCompletionResponse` definidos en Task 1 y usados en su test; `aiConfig` (Task 5) coincide con los nombres de campo de la config de la cadena (Task 3). `OpenAICompatibleExtractorService` y sus opciones son idénticas en Task 1, 3 y 6.
