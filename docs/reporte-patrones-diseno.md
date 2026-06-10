# Reporte de Patrones de Diseño y Oportunidades de Refactorización

**Proyecto:** drive-doc-processor
**Fecha:** 2026-06-09
**Alcance:** `src/**` (18.237 líneas TS/TSX, 110 archivos)
**Objetivo:** Identificar patrones de diseño ya presentes y oportunidades de introducir patrones en código repetido, poco escalable o difícil de mantener.

---

## 1. Resumen ejecutivo

El proyecto tiene una **base arquitectónica sólida** (separación por capas, Repository, un Facade de logging, un dispatcher de prompts bien hecho). El problema **no es ausencia de diseño, sino inconsistencia en su aplicación**: las mismas decisiones se resuelven bien en un lugar y a mano en otro.

Los tres focos de deuda más rentables son:

1. **Extractores de IA sin abstracción común** → el fallback Gemini→OpenAI→Claude está **copiado en 2 lugares** (pipeline y ruta de scan manual). Falta un contrato `AiExtractor` + una cadena reutilizable.
2. **Boilerplate de rutas API** → auth-guard repetido en 28 archivos, bloque `ZodError` idéntico en 12, 77 respuestas de error ad-hoc. Falta un wrapper (HOF/middleware).
3. **`processDriveFile` es una God function de ~595 líneas** con estado mutable compartido y 6 caminos de salida. Es el corazón del sistema y el código más riesgoso de tocar.

La métrica de priorización usada es `Prioridad = (Impacto + Riesgo) × (6 − Esfuerzo)`, con cada eje de 1 a 5.

---

## 2. Patrones de diseño YA presentes (no romper)

Vale la pena documentarlos porque la refactorización debe **extender estos patrones**, no inventar otros nuevos en paralelo.

| Patrón | Dónde | Estado |
|--------|-------|--------|
| **Repository** | `repositories/{consortium,invoice,provider,payment,client}.repository.ts` | Bien aplicado, pero ver H6 (se saltea en el pipeline). |
| **Strategy + Factory (dispatcher)** | `lib/extraction.ts` → `buildExtractionPrompt()` rutea a `buildEdesurPrompt` / `buildAysaPrompt` / `buildGasPrompt`… según `identifyLSPProvider()`. Reglas compartidas (`CONSORTIUM_ADDRESS_RULES`, `INVALID_DATE_RULES`, `PAYMENT_METHOD_RULES`) por composición. | **Ejemplo a imitar.** Es exactamente el patrón que falta en los extractores de IA. |
| **Facade de logging** | `lib/logger.ts` → `schedulerLog`, `workerLog`, `pipelineLog`, `cycleLog`. Métodos semánticos (`jobClaimed`, `consortiumMatch`…). | Muy bueno. El problema es que **no se usa en todos lados** (ver H8). |
| **Pipeline funcional puro** | `lib/consortiumNormalizer.ts` → `normalizeConsortiumName` compone 7 transformaciones (`stripConsortiumPrefix` → `expandAbbreviations` → … → `extractStreetAndNumber`). | Limpio, testeable, legible. No tocar. |
| **Singleton** | `lib/prisma.ts` → `getPrismaClient()`. | Correcto. |
| **Adapter (implícito)** | Cada extractor adapta su SDK (Gemini/OpenAI/Anthropic) a `ExtractedDocumentData`. | Correcto en intención, pero **sin interfaz declarada** (ver H1). |
| **Helpers de configuración (Resolver)** | `lib/clientProcessingConfig.ts` → `resolveGoogleConfig`, `resolveFolders`, `resolveMapping`, `resolveAiConfig`. | Buen primer paso; falta el Factory que los una (ver H5). |

---

## 3. Hallazgos y oportunidades (ordenados por prioridad)

### H1 — Extractores de IA sin contrato común; fallback duplicado · Prioridad **32** 🔴
**Patrón propuesto: Strategy + Chain of Responsibility**

**Evidencia:**
- `GeminiExtractorService`, `AiExtractorService` (OpenAI) y `ClaudeExtractorService` exponen la **misma interfaz exacta** (`extractStructuredData(text)`, `getLastUsage()`, constructor `{apiKey, model}`, campo `lastUsage: AiUsageMetrics`) pero **no implementan una interfaz declarada**.
- La cadena de fallback está **duplicada** con lógica casi idéntica:
  - `jobs/processPendingDocuments.job.ts:736-781` (3 bloques `try/catch` que prueban Gemini → OpenAI → Claude, loguean con `pipelineLog`).
  - `app/api/client/consortiums/[id]/invoices/scan/route.ts:200-228` (los **mismos** 3 bloques, pero loguean con `console.warn` — ya divergieron).

**Por qué importa:** agregar un proveedor nuevo, cambiar el orden de fallback o corregir un bug de manejo de errores obliga a editar 2+ lugares que ya se comportan distinto. Es el caso de libro de Strategy.

**Refactor sugerido:**
```ts
// types/aiExtractor.ts
export interface AiExtractor {
  readonly provider: string;
  extractStructuredData(text: string): Promise<ExtractedDocumentData>;
  getLastUsage(): AiUsageMetrics | null;
}

// services/aiExtractionChain.ts
export class AiExtractionChain {
  constructor(private readonly extractors: AiExtractor[]) {}
  async run(text: string, onAttempt?: (p: string, ok: boolean, err?: string) => void)
    : Promise<{ data: ExtractedDocumentData; usage: AiUsageMetrics | null } | null> {
    for (const ex of this.extractors) {
      try {
        const data = await ex.extractStructuredData(text);
        onAttempt?.(ex.provider, true);
        return { data, usage: ex.getLastUsage() };
      } catch (e) {
        onAttempt?.(ex.provider, false, e instanceof Error ? e.message : "unknown");
      }
    }
    return null;
  }
}
```
La construcción de la cadena (qué extractores y en qué orden, según las keys disponibles) vive en un solo lugar (Factory). `onAttempt` desacopla el logging para que cada caller (pipeline vs scan) use el suyo sin duplicar la cadena.

**Scores:** Impacto 4 · Riesgo 4 · Esfuerzo 2 → **32**

---

### H4 — Boilerplate de rutas API repetido · Prioridad **28** 🔴
**Patrón propuesto: Higher-Order Function / Decorator (middleware de ruta)**

**Evidencia (cuantificada):**
- `if (auth.error) return auth.error;` repetido en **28 archivos** (38 ocurrencias).
- Bloque ternario `error instanceof z.ZodError ? … : error instanceof Error ? …` **idéntico, copy-paste literal**, en **12 archivos** (`rubros`, `coeficientes`, `providers`, `consortiums`, `clients`…).
- `NextResponse.json({ ok: false, … })` en **28 archivos** (77 ocurrencias), con status codes elegidos a ojo.

**Por qué importa:** cada endpoint nuevo arrastra ~20 líneas de plumbing. Un cambio en el formato de error, o reforzar el manejo de auth, hay que replicarlo a mano. Es fácil que un endpoint olvide el `try/catch` y filtre un stack trace (o PII) al cliente.

**Refactor sugerido:**
```ts
// lib/apiHandler.ts
export const ok  = (data: object, status = 200) => NextResponse.json({ ok: true, ...data }, { status });
export const fail = (error: unknown) => {
  if (error instanceof z.ZodError)
    return NextResponse.json({ ok: false, error: error.issues.map(i => i.message).join(", ") }, { status: 400 });
  const msg = error instanceof Error ? error.message : "Unknown error";
  return NextResponse.json({ ok: false, error: msg }, { status: 500 });
};

export function withClientAuth(handler: (ctx: { req: NextRequest; session: ClientSession }) => Promise<NextResponse>) {
  return async (req: NextRequest) => {
    const auth = requireClientSession(req);
    if (auth.error) return auth.error;
    try { return await handler({ req, session: auth.session }); }
    catch (e) { return fail(e); }
  };
}
```
Un endpoint pasa de ~55 líneas a ~15. Se puede migrar **incrementalmente** (ruta por ruta, sin big-bang).

**Scores:** Impacto 4 · Riesgo 3 · Esfuerzo 2 → **28**

---

### H5 — Ensamblaje de `ProcessingClient` / config duplicado · Prioridad **24** 🟠
**Patrón propuesto: Factory Method**

**Evidencia:** el mismo bloque `prisma.client.findUnique({ select: { driveFoldersJson, googleConfigJson, extractionConfigJson } })` + mapeo manual a `ProcessingClient` + `resolveGoogleConfig`/`resolveFolders` se repite en **~7 rutas**:
`invoices/route.ts`, `invoices/scan/route.ts`, `invoices/[invoiceId]/route.ts`, `invoices/[invoiceId]/receipt/route.ts`, `invoices/[id]/payments/route.ts`, `payments/[paymentId]/route.ts`, `setup-sheet-protection/route.ts`, `clients/[id]/purge/route.ts`.

Peor: las rutas manuales hardcodean valores inconsistentes (`scan/route.ts:158-167` pone `name: ""`, `batchSize: 10`, `intervalMinutes: 60`), mientras la ruta automática (`runProcessingCycle.ts`) usa el cliente real. Dos representaciones del mismo concepto que pueden divergir.

**Refactor sugerido:** un único `loadProcessingClient(clientId): Promise<ProcessingClient>` en `clientProcessingConfig.ts`, y opcionalmente `buildProcessJobConfig(client)` que produzca el `ProcessJobConfig` (hoy ese mapeo `folders.pending → drivePendingFolderId …` también está duplicado entre `runProcessingCycle.ts:77-92` y las rutas de scan).

**Scores:** Impacto 3 · Riesgo 3 · Esfuerzo 2 → **24**

---

### H2 — `processDriveFile` es una God function (~595 líneas) · Prioridad **18** 🟠
**Patrón propuesto: Pipeline / Chain of Responsibility de pasos (Pipe & Filter)**

**Evidencia:** `jobs/processPendingDocuments.job.ts:561-1155`. Una sola función maneja: descarga, lock en Drive, dedup por hash, 3 flujos de extracción (imagen / PDF cacheado / PDF normal), gate "sin monto", saneo de CUIT inventado, dedup por business key, limpieza de `clientNumber`, assignment, fallback visual, canonización, escritura en Sheets, organización del archivo (4 destinos), persistencia y emisión de métricas. Todo con estado mutable compartido (`extracted`, `isDuplicate`, `assignment`, el acumulador `m`) y **6 puntos de salida** (`no_amount`, `unassigned`, `no_period`, `ok`, `duplicate`, `failed`).

**Por qué importa:** es el código más crítico y más caro de modificar del proyecto. No es unit-testeable por pasos. Cada cambio arriesga una regresión en un camino no relacionado.

**Refactor sugerido:** modelar un `PipelineContext` que fluye por pasos discretos (`DownloadStep`, `DedupHashStep`, `ExtractStep`, `MissingAmountGate`, `BusinessKeyDedupStep`, `AssignmentStep`, `CanonizeStep`, `SheetsStep`, `FileOrganizationStep`, `PersistStep`), cada uno con la firma `(ctx) => StepResult<Continue | Halt(reason)>`. La emisión de la línea `[metrics]` se vuelve un `finally` del runner, no lógica entrelazada. **Prerrequisito: tests de caracterización** sobre los 6 caminos antes de tocar nada.

**Scores:** Impacto 5 · Riesgo 4 · Esfuerzo 4 → **18**

---

### H3 — Cadena de "Intentos" en matching consorcio/proveedor · Prioridad **18** 🟠
**Patrón propuesto: Chain of Responsibility (estrategias ordenadas)**

**Evidencia:** `resolveAssignment` (`processPendingDocuments.job.ts:238-559`) tiene dos cadenas secuenciales de `if (!matched) { intento N }`:
- Consorcio: CUIT → exacto → fuzzy → alias (líneas 383-437).
- Proveedor: CUIT allTaxIds → CUIT legacy → nombre exacto → nombre parcial (líneas 481-519).

Cada intento es una estrategia con la misma forma (`(input, candidates) → match | null`) pero está inline en una función de 320 líneas que además accede a Prisma directo.

**Refactor sugerido:** array ordenado de `MatchStrategy<Consortium>` y `MatchStrategy<Provider>`; el resolver itera hasta el primer hit y reporta `matchMethod`. Cada estrategia se testea aislada. Habilita agregar/reordenar reglas sin tocar el flujo.

**Scores:** Impacto 3 · Riesgo 3 · Esfuerzo 3 → **18**

---

### H8 — Logging inconsistente: `console.*` vs Facade · Prioridad **16** 🟠
**Patrón propuesto: usar el Facade existente (consolidación), no uno nuevo**

**Evidencia:** **89 ocurrencias** de `console.log/warn/error` en **23 archivos**, conviviendo con el logger estructurado de `lib/logger.ts`. Casos notables: `repositories/invoice.repository.ts` (4, loguean `clientId`/`hash` crudos), `sync-directory/route.ts` (17), `scan/route.ts` (4).

**Por qué importa:** además de inconsistencia operativa (formato/niveles), hay **riesgo de PII**: el pipeline tiene `safeDebugLog()` para sanitizar, pero los `console.*` de repos y rutas escriben identificadores y datos sin pasar por él.

**Refactor sugerido:** extender el Facade con `repoLog`/`apiLog` y reemplazar los `console.*` de dominio. Dejar `console.*` solo en scripts de diagnóstico (`jobs/diagnose-*.ts`).

**Scores:** Impacto 2 · Riesgo 2 · Esfuerzo 2 → **16**

---

### H6 — Se saltea la capa Repository; Prisma acoplado a cada método · Prioridad **15** 🟡
**Patrón propuesto: respetar Repository + inyección del cliente**

**Evidencia:**
- El pipeline accede a Prisma **directo** (`prisma.provider.findMany`, `prisma.consortium.findMany`, `prisma.lspService.findFirst` en `resolveAssignment`), aunque recibe `consortiumRepository` y `providerRepository` como parámetros. El `CLAUDE.md` declara arquitectura por capas estricta; acá se viola.
- Cada método de cada repo empieza con `const prisma = getPrismaClient();` (patrón repetido ~25 veces) en vez de tomarlo en el constructor.

**Refactor sugerido:** mover las queries de `resolveAssignment` a métodos de repositorio (`consortiumRepository.findAllForMatching(clientId)`, etc.) e inyectar `PrismaClient` en el constructor del repo (habilita además mockear en tests).

**Scores:** Impacto 3 · Riesgo 2 · Esfuerzo 3 → **15**

---

### H7 — God Component en la UI (`consortiums/page.tsx`) · Prioridad **7** 🟡
**Patrón propuesto: descomposición en componentes + custom hooks (+ `useReducer`/Context)**

**Evidencia:** `app/admin/consortiums/page.tsx` tiene **2.686 líneas**, **96 `useState`** y **42 handlers** en un único componente.

**Por qué importa:** mantenibilidad y performance (re-renders), y colaboración (conflictos de merge). Pero el **esfuerzo es alto** y el riesgo de regresión visual también, por eso queda con prioridad baja pese al impacto.

**Refactor sugerido:** extraer secciones (Sidebar, Toolbar, modal "Cerrar Período", tabla de consorcios) a componentes; mover el estado de cada dominio a custom hooks (`useConsortiums`, `useScheduler`, `useThemeToggle`); considerar `useReducer` para los grupos de estado relacionados. Hacerlo **incrementalmente**, una sección por PR.

**Scores:** Impacto 4 · Riesgo 3 · Esfuerzo 5 → **7**

---

### H9 — Wrappers triviales en `GoogleDriveService` · Prioridad **10** (nota menor)
`moveFileToScanned` / `moveFileToUnassigned` / `moveFileToFailed` (`googleDrive.service.ts:239-261`) son envoltorios idénticos de `moveFileToFolder` que solo difieren en el nombre semántico. No es un problema de diseño grave; se pueden mantener (aportan legibilidad en el caller) o colapsar. Cosmético.

---

## 4. Tabla de priorización

| # | Hallazgo | Patrón | Imp. | Riesgo | Esf. | **Prioridad** |
|---|----------|--------|:----:|:------:|:----:|:-------------:|
| H1 | Extractores IA sin contrato + fallback duplicado | Strategy + Chain of Responsibility | 4 | 4 | 2 | **32** |
| H4 | Boilerplate de rutas API | HOF / Decorator | 4 | 3 | 2 | **28** |
| H5 | Ensamblaje `ProcessingClient`/config duplicado | Factory Method | 3 | 3 | 2 | **24** |
| H2 | God function `processDriveFile` | Pipeline (Pipe & Filter) | 5 | 4 | 4 | **18** |
| H3 | Cadena de "Intentos" en matching | Chain of Responsibility | 3 | 3 | 3 | **18** |
| H8 | Logging `console.*` vs Facade | Consolidar Facade | 2 | 2 | 2 | **16** |
| H6 | Se saltea Repository; Prisma acoplado | Repository + DI | 3 | 2 | 3 | **15** |
| H9 | Wrappers triviales Drive | — | 1 | 1 | 1 | **10** |
| H7 | God Component UI | Componentes + hooks | 4 | 3 | 5 | **7** |

---

## 5. Plan de remediación por fases

Pensado para hacerse **junto al trabajo de features**, sin un big-bang. Cada fase es independiente y entrega valor por sí sola.

### Fase 1 — Quick wins de alto retorno (esfuerzo bajo, sin tocar el pipeline)
1. **H1 — `AiExtractor` + `AiExtractionChain`.** Define la interfaz, hacé que los 3 servicios la implementen (cambio casi nulo), y reemplazá las dos cadenas duplicadas (job + scan) por la chain. Elimina la divergencia ya existente.
2. **H4 — `withClientAuth` / `withAuth` + `ok()`/`fail()`.** Crear los helpers y migrar 3-4 rutas como piloto (`rubros`, `coeficientes` son las más limpias). Migrar el resto oportunísticamente.
3. **H5 — `loadProcessingClient(clientId)`.** Un helper que colapsa el `select` + mapeo repetido en 7 rutas.

> Resultado: se elimina la mayor parte de la duplicación literal del repo con bajo riesgo.

### Fase 2 — Consistencia de capas y observabilidad
4. **H8 — Consolidar logging** detrás del Facade (`repoLog`/`apiLog`), cerrando el riesgo de PII en `console.*`.
5. **H6 — Mover queries de `resolveAssignment` a repositorios** e inyectar Prisma en constructores. Esto es **prerrequisito natural** para poder testear el pipeline.

### Fase 3 — El núcleo (requiere red de tests primero)
6. **Tests de caracterización** de `processDriveFile` cubriendo los 6 caminos de salida (ok / duplicate / unassigned / no_amount / no_period / failed).
7. **H3 — Extraer `MatchStrategy`** (consorcio y proveedor) como paso preparatorio acotado.
8. **H2 — Descomponer `processDriveFile` en pasos** (Pipeline). Solo después de 6 y 7.

### Fase 4 — Frontend (oportunística, una sección por PR)
9. **H7 — Descomponer `consortiums/page.tsx`** en componentes + custom hooks. Empezar por las piezas más aisladas (Toolbar, modal de cierre de período).

---

## 6. Justificación de negocio (síntesis)

- **Fase 1** reduce el costo marginal de cada endpoint/feature nuevo y elimina bugs por divergencia (el fallback de IA ya se comporta distinto en dos lugares — eso es un bug latente, no solo estética).
- **Fases 2-3** atacan el riesgo: el pipeline es el activo crítico y hoy no es testeable; volverlo testeable y por-pasos reduce el riesgo de regresión de cada cambio futuro de reglas de extracción/matching (que en este dominio cambian seguido).
- **Fase 4** es calidad de vida del desarrollo de UI; alto impacto pero alto esfuerzo, por eso va al final.
