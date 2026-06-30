# Diseño — Más cuota de IA gratis vía Cerebras + Groq

**Fecha:** 2026-06-24
**Estado:** Aprobado (brainstorming) — pendiente de plan de implementación
**Autor:** sesión 36

---

## 1. Problema

El throughput de procesamiento de boletas cayó por debajo de la mitad del histórico
(~80-100/día → menos de la mitad). Causa externa confirmada: **Google recortó el free
tier de Gemini** desde junio. El sistema usa solo Gemini (con fallback opcional a
OpenAI/Claude, sin crédito), cuyo free tier tiene **cuota diaria por modelo**
(`GenerateRequestsPerDayPerProjectPerModel-FreeTier`). El barrido de 5 modelos sumaba
~5 baldes diarios (~100/día), pero con el recorte ya no alcanza para una jornada.

**Restricción dura del owner: la solución debe ser 100% gratis** (sin tier pago, sin
crédito en OpenAI/Claude, sin tarjeta).

## 2. Por qué NO se ataca por frecuencia / batchSize

Con un **tope diario**, `batchSize` e `intervalMinutes` controlan el *ritmo*, no el
*total*. Procesar más rápido solo adelanta el momento en que se agota la cuota; no sube
el techo diario. Ya verificado en prod (ver `decisiones.md`, 2026-06-11). El cuello de
botella es la **cuota diaria total de IA**, no la velocidad de encolado.

## 3. Las tres palancas reales (y la elegida)

| Palanca | Qué hace | Decisión |
|---|---|---|
| Subir oferta — **sumar proveedores de IA con free tier propio** | Cada proveedor es un balde independiente y legítimo | ✅ **Elegida** |
| Bajar demanda — parser determinístico para boletas sistemáticas | Evita gastar IA en LSP/sindicales/ARCA | ❌ Descartada (predominan facturas **variadas**, no sistemáticas → poco retorno) |
| Rotar varias keys/proyectos de Gemini | Multiplica baldes de Gemini | ❌ Descartada (va contra los ToS de Google) |

**Composición del volumen (input del owner):** predominan **facturas variadas**
(proveedores diversos: ascensores, plomería, mantenimiento, seguros, honorarios…), que
son las más heterogéneas. Por eso el parser determinístico rinde poco y la palanca
correcta es sumar oferta de IA gratuita.

## 4. Datos de free tiers (verificados 2026-06)

| Proveedor | Free tier diario | ≈ boletas/día* | Tarjeta | Modelos |
|---|---|---|---|---|
| **Cerebras** | **1.000.000 tokens/día** | **~300+** | ❌ No | Llama 3.3 70B / Llama 4 Scout |
| **Groq** (70B) | 1.000 req/día | ~1.000 | ❌ No | Llama 3.3 70B |
| **Groq** (8B) | 14.400 req/día | ~14.400 | ❌ No | Llama 3.1 8B |
| OpenRouter | 50/día (1.000 si se cargan US$10) | 50–1.000 | ⚠️ $10 | DeepSeek, Llama, etc. |
| Gemini (actual) | recortado | <100 | ❌ No | Gemini Flash |

\* a ~3k tokens por boleta. Fuentes en §13.

**Conclusión:** Cerebras solo (1M tokens/día ≈ 300+ boletas, sin tarjeta) ya supera el
volumen histórico. Sumando Groq 70B (1.000 req/día) el colchón es enorme (~1.300+/día de
capacidad combinada vs ~100/día de necesidad). El problema de cuota desaparece, gratis y
sin tocar los ToS de nadie (cada proveedor es su propio balde).

## 5. Decisiones de diseño tomadas

1. **Orden de cadena: capacidad primero** → `Cerebras → Groq → Gemini → OpenAI → Claude`.
   Se gastan primero los baldes grandes; Gemini queda de respaldo. Las boletas dudosas
   no se pierden (van a Revisión, recuperables).
2. **Modelos por defecto:** `gpt-oss-120b` (Cerebras) y `llama-3.3-70b-versatile`
   (Groq). El 70B prioriza precisión sobre cantidad; ya sobra capacidad con Cerebras, así
   que no hace falta el 8B (configurable por env si en el futuro se necesita más volumen).
3. **Keys globales (env vars), no por cliente.** Las keys gratuitas son del operador y hay
   1 solo cliente en prod → cero migración, cero UI, cero encriptación. La extensión a
   keys por cliente queda como trabajo futuro (YAGNI), siguiendo el patrón encriptado de
   Gemini.
4. **Validación de calidad antes de activar** (gate obligatorio): un script comparador
   corre cada proveedor sobre PDFs reales y muestra los campos lado a lado, para confirmar
   que Llama extrae bien las facturas variadas antes de confiarle el primer lugar.
5. **El scan manual NO se modifica:** los nuevos proveedores entran solo en el pipeline
   automático (el que sufre el techo de cuota). La carga manual desde el panel es puntual
   y de bajo volumen → conserva la cadena actual (Gemini → OpenAI → Claude).

## 6. Arquitectura

### 6.1 Extractor genérico OpenAI-compatible (nuevo)

Cerebras y Groq exponen la **Chat Completions API de OpenAI** (`/v1/chat/completions`),
distinta de la *Responses API* que usa `AiExtractorService` (OpenAI). Por eso se crea un
extractor genérico reutilizable en vez de duplicar código:

```
OpenAICompatibleExtractorService implements AiExtractor
  params: { provider: AiProvider, apiKey: string, baseURL: string, model: string }
  - usa el SDK de OpenAI (ya instalado): new OpenAI({ apiKey, baseURL })
  - client.chat.completions.create({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: buildExtractionPrompt(text) }],
    })
  - reusa parseExtractionOutput + refineExtractionWithRawText (idénticos a los demás)
  - captura usage de response.usage (prompt_tokens / completion_tokens / total_tokens)
    → AiUsageMetrics { provider, model, inputTokens, outputTokens, totalTokens }
```

Instancias:
- **Cerebras** → `baseURL: https://api.cerebras.ai/v1`, `provider: "cerebras"`,
  `model: "gpt-oss-120b"`
- **Groq** → `baseURL: https://api.groq.com/openai/v1`, `provider: "groq"`,
  `model: "llama-3.3-70b-versatile"`

> El prompt ya contiene `JSON_RESPONSE_INSTRUCTION` ("Responde SOLO JSON…"), requisito de
> Groq para activar `json_object` mode. ✔

Beneficio extra: el genérico deja trivial sumar Mistral / OpenRouter / DeepInfra a futuro
(todos OpenAI-compatibles) sin código nuevo, solo otra instancia.

### 6.2 Cadena reordenada

El orden de la cadena lo define el orden de `push` en `createAiExtractionChain`. Nuevo
orden: **Cerebras → Groq → Gemini → OpenAI → Claude**. Cada eslabón se incluye solo si
tiene API key (igual que hoy). `GeminiExtractorService` (barrido de modelos + Vision para
fallback visual) queda **intacto**; solo pasa a tercer lugar.

### 6.3 Interacción con el circuit breaker de cuota (sin cambios de lógica)

El `aiExtractStep` ya cuenta, vía el callback `onAttempt(provider, ok, err, rateLimited)`,
cuántos intentos fallaron (`aiFailures`) y cuántos por rate-limit (`aiRateLimited`). Solo
lanza `RateLimitError` (→ boleta a Pendientes + `aiPausedUntil`) cuando
`aiRateLimited === aiFailures` (TODOS los proveedores en 429). Al sumar Cerebras/Groq, el
breaker pasa a gatillarse solo si **todos** —incluidos los nuevos— están agotados (mucho
más raro y deseable). **Requisito:** que `isRateLimitError` reconozca los 429 de
Cerebras/Groq (ver §7, ajuste de `status === 429`). Sin este ajuste, un 429 de los nuevos
podría clasificarse como fallo genérico → la boleta degradaría a OCR_ONLY → Revisión en
vez de volver a Pendientes.

## 7. Componentes nuevos / tocados

| Archivo | Cambio |
|---|---|
| `src/services/openAICompatibleExtractor.service.ts` | **Nuevo.** Extractor genérico (§6.1). |
| `src/types/aiUsage.types.ts` | `AiProvider` += `"cerebras" \| "groq"`. |
| `src/services/aiExtraction.ts` | `AiExtractionChainConfig` += `cerebras?` / `groq?` (`AiProviderCredentials`). En `createAiExtractionChain`, pushear Cerebras y Groq **antes** de Gemini, usando el extractor genérico (import dinámico). |
| `src/lib/aiErrors.ts` | `isRateLimitError` reconoce también `error.status === 429` y `error.code === "rate_limit_exceeded"` (el SDK de OpenAI lanza `APIError` con `status` numérico). Robustez ante mensajes de Cerebras/Groq que no contengan literalmente "429"/"quota". |
| `src/jobs/processPendingDocuments.job.ts` | Resolver `cerebrasApiKey`/`groqApiKey` (+ `*Model`) de `config.aiConfig` con fallback a `env`; pasarlos a `createAiExtractionChain`. |
| `src/config/env.ts` | Nuevas env opcionales: `CEREBRAS_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_MODEL`, `GROQ_MODEL`. |
| `scripts/compare-extractors.ts` | **Nuevo.** Comparador de calidad (§9). |

> Nota: `config.aiConfig` hoy se arma con `geminiApiKey`/`openaiApiKey`/`anthropicApiKey`
> (+ models). Se le agregan los campos `cerebrasApiKey`/`groqApiKey` (+ models); como son
> globales, en la práctica se resuelven del `env`. No se toca `googleConfigJson` ni la
> encriptación.
>
> **El scan manual (`.../invoices/scan/route.ts`) NO se modifica** (decisión del owner):
> es carga puntual y de bajo volumen, no es lo que sufre el techo de cuota, así que conserva
> su cadena actual (Gemini → OpenAI → Claude). Los nuevos proveedores entran **solo en el
> pipeline automático**.

## 8. Configuración (sin migración, sin UI)

```env
# Nuevas (opcionales; si faltan, ese eslabón no se agrega a la cadena)
CEREBRAS_API_KEY=
GROQ_API_KEY=
CEREBRAS_MODEL=gpt-oss-120b              # default si se omite (Cerebras retiró Llama del free tier)
GROQ_MODEL=llama-3.3-70b-versatile        # default si se omite
```

En `docker-compose.yml`, propagar estas env al servicio `worker` (y `web`, para el scan
manual). El owner obtiene las keys gratis (sin tarjeta) en los consoles de Cerebras y Groq.

## 9. Plan de validación de calidad (gate previo al deploy)

**`scripts/compare-extractors.ts <ruta.pdf> [<ruta2.pdf> ...]`** — solo lectura, **sin
DB ni Sheets**:

1. Extrae el texto con el mismo flujo del pipeline (`PdfTextExtractorService` +
   `identifyLSPProvider` para el rango de páginas).
2. Para **cada proveedor configurado** (Cerebras, Groq, Gemini, …) corre
   `extractStructuredData` sobre el mismo texto.
3. Imprime una tabla comparativa por PDF: provider · model · consorcio · proveedor ·
   CUIT · monto · vencimiento · N° boleta · tokens · tiempo.

Permite al owner correr un puñado de **facturas variadas reales** y confirmar que Llama
(Cerebras/Groq) extrae igual que Gemini antes de poner los nuevos al frente en prod. Si
alguna falla, el fallback de la cadena la cubre y ninguna boleta se pierde (van a Revisión,
recuperables).

## 10. Fases de entrega

1. **Extractor genérico + tipos + cadena** (TDD: tests del nuevo servicio con un fake del
   SDK; test del orden de la cadena en `createAiExtractionChain`).
2. **`isRateLimitError` con `status === 429`** (test del nuevo caso).
3. **Wiring** en pipeline + `env.ts` + `docker-compose.yml` (el scan manual NO se toca).
4. **`scripts/compare-extractors.ts`**.
5. **Validación** con PDFs reales (la corre el owner con sus keys) → recién entonces deploy
   del worker/web.

## 11. Qué NO se hace (YAGNI)

- ❌ Parser determinístico para LSPs (predominan facturas variadas → poco retorno).
- ❌ Rotación de keys/proyectos de Gemini (va contra los ToS de Google).
- ❌ OpenRouter (requiere cargar US$10 para el tier útil → no es gratis puro).
- ❌ Keys de Cerebras/Groq por cliente / UI / encriptación (env global alcanza para 1
  cliente; se agrega luego si hay multi-tenant real).
- ❌ Tocar el barrido de modelos de Gemini ni la Vision (quedan intactos).
- ❌ Cambiar `batchSize` / `intervalMinutes` (no es la palanca; ver §2).

## 12. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Llama menos preciso que Gemini en facturas raras | Gate de validación (§9) antes de activar; fallback en cadena; refinamiento determinístico existente (`refineExtractionWithRawText`, `extractCuitsFromText`) aplica a todos por igual; las dudosas van a Revisión (recuperables), no se pierden. |
| **Cerebras free tier limita el contexto a 8.192 tokens** | Boletas normales usan ~3k. El caso ARCA F931 (texto completo, 2 páginas) podría exceder → Cerebras devuelve error → fallback automático a Groq/Gemini. |
| Nombres de modelo cambian en los proveedores | Configurables por env; el plan de implementación verifica los nombres vigentes contra la doc actual. |
| 429 de Cerebras/Groq mal clasificado | Ajuste de `isRateLimitError` (`status === 429`) + test (§7). |
| `json_object` mode rechazado si el prompt no dice "json" | Ya cubierto: el prompt incluye `JSON_RESPONSE_INSTRUCTION`. ✔ |

## 13. Fuentes (free tiers, 2026-06)

- Groq — [console.groq.com/docs/rate-limits](https://console.groq.com/docs/rate-limits) ·
  [TokenMix: Groq free tier 2026](https://tokenmix.ai/blog/groq-free-tier-limits-2026)
- Cerebras — [inference-docs.cerebras.ai/support/rate-limits](https://inference-docs.cerebras.ai/support/rate-limits) ·
  [getaiperks: Cerebras 1M tokens/día](https://www.getaiperks.com/en/ai/cerebras-free-tier-guide)
- OpenRouter — [openrouter.ai/docs/api/reference/limits](https://openrouter.ai/docs/api/reference/limits)

## 14. Verificación

`npm test` + `npm run typecheck` + `npm run lint` + `npm run build:jobs`, manteniendo
verdes los tests de caracterización del pipeline (`processPendingDocuments.job.test.ts`).
Sin cambio de comportamiento observable salvo el orden de proveedores en la cadena. Sin
migración de DB.
