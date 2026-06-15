# Spec — Triage de documentos: clasificar boleta vs no-boleta

Fecha: 2026-06-15
Estado: Propuesto (diseño aprobado). Pendiente de plan de implementación.
Origen: necesidad de que la carpeta Pendientes recibe documentos que NO son boletas
(planos de edificio, certificados de desinfección/fumigación, obleas de rúbrica de libros,
disposiciones, etc.). Hoy todos pasan por la IA y terminan en "sin monto" → Revisión o en
Sin Asignar, gastando tokens y ensuciando esas carpetas. Además, hay boletas genuinas pero
atípicas ("particulares" tipo MAYO) que no deben rechazarse por error.

Prerrequisito ya cumplido: el pipeline fue refactorizado a Pipe & Filter (refactor H2,
`docs/superpowers/specs/2026-06-14-refactor-h2-pipeline-design.md`), así que agregar pasos
nuevos es barato y testeable.

---

## 1. Objetivo

Introducir una **capa de triage** en el pipeline que clasifique cada documento como
**boleta** o **no-boleta** (clasificación binaria) y derive los no-boleta sin gastar tokens
de IA cuando sea evidente, sin ensuciar las métricas de boletas reales. El triage debe tener
**sesgo conservador**: ante la duda, tratar el documento como boleta y seguir el flujo normal
(perder una boleta genuina es mucho peor que gastar unos tokens de más o mover un no-boleta a
Revisión).

**No-objetivos (YAGNI):**
- No se clasifica el tipo específico del no-boleta (binario: boleta / no-boleta).
- No se agregan carpetas de Drive nuevas (los no-boleta van a Revisión, igual que "sin monto").
- No se agregan patrones nuevos de boletas particulares en este spec; el sesgo conservador
  cubre que no se rechacen. Las mejoras puntuales de prompt para particulares son iterativas
  y posteriores, caso por caso.
- No hay config por cliente para los marcadores (viven en el lib, ampliables).

---

## 2. Mecanismo: híbrido en dos capas

| Capa | Dónde | Costo | Qué atrapa |
|---|---|---|---|
| **1. Heurística** | Sobre el texto del PDF, **antes** de la IA | 0 tokens | No-boletas evidentes (oblea, certificado sin monto, plano…) |
| **2. IA** | Campo `isBoleta` en la respuesta de la IA, **después** de extraer | tokens ya pagados | No-boletas que la heurística dejó pasar pero la IA reconoce |

La capa 1 corta antes de llamar a la IA → ahorra tokens en lo obvio. La capa 2 es la red para
lo dudoso. Ambas derivan al mismo destino (ver §5).

---

## 3. Cambios en el pipeline

Hoy `extractStep` hace texto + IA juntos. Se **separa en dos** y se insertan dos gates:

```
downloadAndLockStep
dedupHashStep
textExtractStep      ← NUEVO  (pdf-parse + identifyLSPProvider; sin tokens)
documentTriageGate   ← NUEVO  (capa 1: heurística; puede halt "not_boleta")
aiExtractStep        ← (ex-extractStep, solo la parte IA: Vision / cacheado / normal)
isBoletaGate         ← NUEVO  (capa 2: lee ctx.extracted.isBoleta; puede halt "not_boleta")
missingAmountGate
cuitSanitizeStep
businessKeyDedupStep
cleanClientNumberStep
assignmentStep
canonizeStep
unassignedGate
noPeriodGate
sheetsStep
fileOrganizationStep
persistStep
```

### `textExtractStep`
Extrae el texto del PDF (la lógica de texto que hoy vive en `extractStep`: `extractTextFromPdf`,
detección `identifyLSPProvider`, re-extracción página 1 para LSP, métricas `m.textSource`/
`textChars`/`emitterBlock`/`ms.ocr`). Setea `ctx.docText`, `ctx.lspProvider`, `ctx.isImage`.
**No llama a la IA.** Para imágenes (JPG/PNG) no hay texto → `ctx.docText` queda vacío y se
marca `ctx.isImage = true`.

### `documentTriageGate` (capa 1)
Si `ctx.docText` no está vacío y `classifyDocumentType(ctx.docText) === "not_boleta"` →
**halt** con `result = "not_boleta"`, `reason = "heuristic"` (destino en §5). Si está vacío
(imagen) o el clasificador no está seguro → `continue`.

### `aiExtractStep`
La parte IA de la extracción actual: flujo imagen (Gemini Vision), flujo cacheado (reusa
extracción previa) y flujo normal (`aiChain.run` sobre `ctx.docText`). Setea `ctx.extracted`,
`ctx.fileAiUsage`, `m.ai`/`m.extracted`, y conserva el manejo de `RateLimitError` (lo relanza;
el runner lo captura). Es el mismo código que hoy, sin la parte de texto.

### `isBoletaGate` (capa 2)
Si `ctx.extracted?.isBoleta === false` → **halt** con `result = "not_boleta"`,
`reason = "ai"`. Si es `true`, `undefined` o el flujo fue OCR_ONLY → `continue` (sesgo
conservador: solo corta ante un `false` explícito).

---

## 4. Clasificador heurístico (`src/lib/documentClassifier.ts`)

Función pura, testeable, estilo `consortiumNormalizer`:

```ts
export type DocumentClass = "not_boleta" | "boleta";
export function classifyDocumentType(text: string): DocumentClass;
```

Analiza los primeros ~4000 caracteres (como `identifyLSPProvider`). Devuelve `"not_boleta"`
**solo si se cumplen ambas condiciones**:

1. **Hay ≥1 señal negativa fuerte** (no-boleta), p. ej.:
   `OBLEA`, `RÚBRICA`/`RUBRICA` (de libros), `CERTIFICADO DE DESINFECCIÓN`/`DESINSECTACIÓN`/
   `DESRATIZACIÓN`/`FUMIGACIÓN`, `CONTROL DE PLAGAS`, `PLANO`, `DISPOSICIÓN`, `HABILITACIÓN`,
   `INFORME TÉCNICO`, `ACTA`. (Lista en el lib, ampliable; comparación en upper, sin acentos
   tolerada.)
2. **Y NO hay señales de boleta**, p. ej.: símbolo de monto (`$`), `TOTAL A PAGAR`, `IMPORTE`,
   `VENCIMIENTO`, un CUIT válido (regex+checksum, `extractCuitsFromText`), `FACTURA`, `RECIBO`,
   `COMPROBANTE`, `CAE`.

En cualquier otro caso devuelve `"boleta"` (= proceder). Esto implementa el sesgo conservador
y resuelve el caso clave: un **certificado de fumigación sin monto** → `not_boleta`; una
**factura de la empresa de fumigación** (tiene monto + CUIT + "factura") → tiene señales de
boleta → `boleta` → flujo normal.

> Las boletas LSP (servicios públicos) tienen montos y marcadores de empresa, así que la
> heurística las deja pasar; no requieren tratamiento especial acá.

---

## 5. Destino del no-boleta (ambas capas, mismo manejo)

Igual patrón que el gate "sin monto" actual:
- **Renombrar** con prefijo `[NO BOLETA] <nombre>` (helper nuevo en `documentValidation.ts`,
  espejo de `appendNoAmountTag`).
- **Mover a Revisión** (`driveFailedFolderId`). Si no está configurada → se queda donde está
  (sin error), como hoy con sin-monto.
- **No** se escribe en Sheets ni se guarda Invoice.
- `summary.notBoleta` += 1 (campo opcional nuevo, mismo patrón que `summary.rateLimited`).
- Línea `[metrics]`: `result = "not_boleta"`, `reason = "heuristic" | "ai"`.

---

## 6. Cambios de tipos / contratos

- `ExtractedDocumentData`: nuevo campo opcional `isBoleta?: boolean`. Vive en el JSON de
  extracción → **sin migración de DB**.
- `ProcessJobSummary`: nuevo campo opcional `notBoleta?: number`. Mostrado en
  `pipelineLog.batchSummary` y en el resumen del worker.
- `PipelineContext`: ya tiene `docText`, `lspProvider`, `isImage`, `extracted` (del refactor
  H2). No requiere campos nuevos.
- Prompts: `buildInvoicePrompt` agrega instrucción para `isBoleta` (default `true`; `false`
  solo si claramente no es factura/recibo/comprobante). Los prompts LSP no se tocan.

---

## 7. Casos borde

- **Imagen (JPG/PNG):** sin texto → capa 1 se saltea; solo aplica capa 2 (la IA Vision decide
  `isBoleta`).
- **OCR_ONLY (la IA falló):** `extracted` sin `isBoleta` → tratado como boleta → sigue al gate
  sin-monto como hoy. No empeora.
- **Duplicado por hash (re-proceso):** ya era boleta → la heurística lo deja pasar; inofensivo.
- **Falso negativo de ambas capas:** un no-boleta no detectado fluye como hoy (sin-monto/Sin
  Asignar). Nunca peor que el comportamiento actual.
- **Falso positivo de la capa 1 (riesgo a minimizar):** una boleta genuina mandada a Revisión
  por error. Mitigación: la condición exige señal negativa fuerte **y** ausencia total de
  señales de boleta; los tests cubren la factura-de-fumigación-con-monto para fijar este
  límite.

---

## 8. Testing

- **Unitarios puros** de `classifyDocumentType` (nuevo `documentClassifier.test.ts`):
  boleta común, factura LSP, certificado de fumigación SIN monto (`not_boleta`), oblea de
  rúbrica (`not_boleta`), plano (`not_boleta`), y **factura de fumigación CON monto**
  (`boleta` — fija el límite del falso positivo).
- **Caracterización del pipeline** (`processPendingDocuments.job.test.ts`, infra del H2):
  - camino `not_boleta` por heurística: verifica que **no** se llamó a `aiChain.run`,
    que se renombró `[NO BOLETA]`, se movió a Revisión, y NO hubo Sheets/save;
    `summary.notBoleta === 1`; `m.result === "not_boleta"`, `reason === "heuristic"`.
  - camino `not_boleta` por IA: `aiChain.run` devuelve `isBoleta: false` → mismo destino,
    `reason === "ai"`.
  - Los 8 tests existentes deben seguir verdes (el split de `extractStep` no cambia
    comportamiento de los caminos actuales).

---

## 9. Alternativas descartadas

- **Triage solo post-IA** (`isBoleta` en el prompt, sin heurística): más simple pero paga
  tokens hasta para basura evidente. Descartado: se quiere ahorro en lo obvio.
- **Triage solo heurístico** (sin capa IA): frágil ante documentos nuevos/atípicos y con más
  riesgo de rechazar boletas genuinas. Descartado.
- **Clasificar en el scheduler antes de encolar:** obliga a leer/parsear el PDF dos veces y no
  encaja con el pipeline; más complejidad por poco beneficio. Descartado.
- **Tipo específico del no-boleta** (certificado/oblea/plano…): YAGNI; binario alcanza, el
  admin abre el archivo en Revisión.
- **Carpeta "Otros documentos" o archivado por edificio:** YAGNI; Revisión + prefijo
  `[NO BOLETA]` separa lo suficiente sin infra nueva.

---

## 10. Orden de implementación sugerido

1. **Capa 1** (mayor ahorro de tokens, autocontenida): `documentClassifier.ts` + tests
   unitarios → split `extractStep` en `textExtractStep` + `aiExtractStep` → `documentTriageGate`
   → helper `[NO BOLETA]` + destino + `summary.notBoleta` + métricas → test de caracterización
   heurística.
2. **Capa 2**: `isBoleta` en `ExtractedDocumentData` + instrucción en `buildInvoicePrompt` →
   `isBoletaGate` → test de caracterización IA.

Cada capa deja la suite verde. Sin migración. Deploy: push (CI) + rebuild del worker.
