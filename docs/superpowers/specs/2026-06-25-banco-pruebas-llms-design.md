# Diseño — Banco de pruebas local de LLMs

**Fecha:** 2026-06-25
**Estado:** Aprobado (brainstorming) — pendiente de plan de implementación
**Autor:** sesión 36

---

## 1. Problema / objetivo

Para iterar prompts y comparar modelos (Cerebras / Groq / Gemini) hace falta una forma de
procesar **boletas reales** localmente, simulando el pipeline, sin tocar la producción del
cliente. El `compare-extractors.ts` ya compara la extracción cruda, pero no replica el resto del
flujo (triage, matching, canonización, resultado final). Se quiere un **banco de pruebas** que
tome boletas de una carpeta del disco, las pase por la lógica del pipeline y registre todo lo que
se generaría (fila de Sheets, Invoice de DB) **sin escribir en ningún lado**, para mejorar la
extracción de forma medible.

## 2. Decisiones tomadas (brainstorming)

1. **Destino del registro: archivos locales.** Reportes en la carpeta de pruebas (JSON + MD). El
   "registro real en DB/Sheets" se materializa como un **dry run**: el reporte muestra la fila
   exacta que iría a Sheets y el objeto Invoice que iría a la DB, sin escribir.
2. **Alcance: pipeline completo.** Extracción IA + triage + gate sin-monto + matching real
   (lee la DB en **solo lectura**, como `diag-boleta`) + canonización + resultado final.
3. **Evaluación: ground truth opcional.** Por defecto muestra todo lado a lado; si junto a una
   boleta hay un archivo de esperados, calcula aciertos/errores por campo y por modelo.
4. **Enfoque A — reusar las funciones puras del pipeline** (no correr `runPipeline` con mocks).
   El banco llama directamente a las piezas ya existentes y validadas. Menor riesgo, reusa
   código testeado, y encaja con "comparar modelos" (que exige correr cada modelo por separado,
   cosa que la cadena real —que corta en el primero que acierta— no permite).
5. **No fine-tuning.** "Entrenar modelos" se interpreta como afinar prompts y elegir el mejor
   modelo (prompt engineering + comparación), no reentrenar pesos.

## 3. Arquitectura

Dos piezas con responsabilidades separadas:

### 3.1 `src/lib/testbench.ts` — lógica pura (testeable)

```
runLogicalPipeline(input: {
  text: string;
  extractor: AiExtractor;
  directory: TestbenchDirectory;   // consorcios + proveedores + lspServices del cliente
}): Promise<TestbenchResult>
```

Replica la **secuencia lógica** del pipeline reusando funciones existentes:
1. `identifyLSPProvider(text)` → tipo de documento.
2. `classifyDocumentType(text)` (triage capa 1) → si es claramente no-boleta, corta.
3. `extractor.extractStructuredData(text)` → extracción IA (campo `isBoleta` = triage capa 2).
4. `isMissingAmount(extracted)` → gate sin-monto.
5. `extractCuitsFromText(text)` + merge con `allTaxIds` (no-LSP).
6. `matchConsortium(...)` / `matchProvider(...)` (de `assignmentMatching.ts`, las mismas que usa
   el pipeline y `diag-boleta`) contra el `directory`.
7. Canonización: reemplaza por datos canónicos; `annotateSindicalProvider` si aplica.
8. El bloque `canonical` (consorcio / proveedor / CUIT / monto / vto / N°) representa **lo que se
   registraría en Sheets y en la DB** — el banco lo muestra en el reporte, sin escribir nada.

Devuelve un `TestbenchResult`:
```
{
  lspProvider, triage: { isBoleta, reason },
  extracted,                 // crudo de la IA
  match: { consortium, consortiumMethod, provider, providerMethod },
  canonical,                 // datos canónicos finales = lo que se registraría en Sheets/DB (no se escribe)
  result,                    // "ok" | "unassigned" | "no_boleta" | "no_amount"
  reason,                    // detalle del resultado (heuristic / ai / consortium_not_found / ...)
  usage,                     // tokens del modelo
  errors: string[]
}
```

```
compareToExpected(result: TestbenchResult, expected: ExpectedFields): FieldComparison
```
Compara campo por campo (montos por valor numérico, CUITs por dígitos con `cuitsEqual`, strings
por igualdad normalizada). Devuelve `{ field: "ok"|"mismatch"|"absent", ... }` + un conteo.

### 3.2 `scripts/llm-testbench.ts` — CLI orquestador

- Args: `npx tsx scripts/llm-testbench.ts [carpeta] [cliente]`.
  - `carpeta` default: `./pruebas de LLMs`.
  - `cliente` default: el primer cliente activo (o se pasa `MorinigoAdm` / un id).
- Carga el `directory` del cliente desde la DB (read-only: consorcios, proveedores, lspServices).
- Construye los extractores configurados (Cerebras / Groq / Gemini / OpenAI según las env keys),
  igual que `compare-extractors.ts`.
- Por cada `*.pdf` de la carpeta (ignora `_resultados/` y `*.expected.json`):
  1. Extrae el texto una vez (`PdfTextExtractorService`).
  2. Para cada modelo: `runLogicalPipeline(text, extractor, directory)`.
  3. Si existe `<nombre>.expected.json`: `compareToExpected` por modelo.
- Escribe los reportes en `pruebas de LLMs/_resultados/<YYYY-MM-DD_HH-mm>/`.
- Imprime en consola un resumen (por modelo: nº boletas, % aciertos si hay ground truth,
  tokens y tiempo promedio).

## 4. Estructura de carpetas

```
pruebas de LLMs/                 (configurable; va al .gitignore — datos reales del cliente)
├── factura1.pdf
├── factura1.expected.json       ← opcional (ground truth)
├── factura2.pdf
└── _resultados/
    └── 2026-06-25_18-30/
        ├── resultados.json      ← detalle completo (programático)
        └── reporte.md           ← tabla legible boleta × modelo + resumen de aciertos
```

## 5. Formato de ground truth (`<nombre>.expected.json`)

Todos los campos son opcionales; el banco solo compara los presentes.
```json
{
  "consortium": "BELGRANO 2458",
  "provider": "SISE SUDAMERICANA SRL",
  "providerTaxId": "30-71882385-0",
  "amount": 105000,
  "dueDate": "2026-04-07",
  "boletaNumber": "0001-00000945",
  "result": "ok"
}
```
- `consortium` / `provider` se comparan contra el valor **canónico** resuelto por el matching.
- `amount` por valor numérico (normalizado con `normalizeBusinessAmount`).
- `providerTaxId` por dígitos (`cuitsEqual`).
- `result` contra el resultado final del banco.

## 6. Formato del reporte

**`resultados.json`** — array, una entrada por boleta:
```
{ "file": "...", "router": "ARCA|factura común|...", "textChars": 4605,
  "models": [ { "provider": "cerebras", "model": "gpt-oss-120b", "ms": 1498,
               "result": "ok", "reason": null, "extracted": {...}, "canonical": {...},
               "match": {...}, "usage": {...}, "comparison": {...}|null } ] }
```

**`reporte.md`** — por boleta, una tabla con los campos clave (consorcio · proveedor · CUIT ·
monto · vto · N° · resultado) por modelo, y al lado el ✓/✗ si hay ground truth. Cierra con un
**resumen por modelo**: nº de boletas, aciertos por campo, tokens y latencia promedio.

**Consola** — el resumen por modelo, para ver de un vistazo cuál anduvo mejor.

## 7. Iterar prompts

El banco usa los **prompts reales** del código (`extraction.ts`). El ciclo de trabajo es: editar
el prompt → re-correr el banco → comparar el reporte nuevo contra el anterior (o contra el ground
truth). No se agrega override de prompts por archivo (YAGNI; se evalúa si hace falta).

## 8. Caveats

| Caveat | Manejo |
|---|---|
| **OCR no corre local** (poppler/tesseract solo en la imagen Docker) | Boletas-imagen (sin texto) dan texto vacío local → el banco lo detecta y avisa "sin texto — probar en el pipeline real". Boletas con texto andan bien. |
| **Datos reales del cliente** en la carpeta | `pruebas de LLMs/` va al `.gitignore`. El reporte no incluye PII más allá de lo que ya está en las boletas. |
| **Matching simplificado** | Usa `matchConsortium`/`matchProvider` (como `diag-boleta`). El fast-path de LspService del pipeline no se replica en v1 (la mayoría son facturas comunes/variadas que matchean por CUIT/nombre). Documentado; se amplía si hace falta. |
| **La cadena real corta en el primero** | El banco corre cada modelo **por separado** (no la cadena), para poder compararlos. |

## 9. Qué NO hace (YAGNI)

- ❌ No escribe en DB/Sheets (todo dry-run). El matching solo lee.
- ❌ No hace fine-tuning de modelos.
- ❌ No vuelca a un sandbox de DB/Sheets (se descartó en favor de archivos locales).
- ❌ No override de prompts por archivo (se editan en el código).
- ❌ No replica los pasos con side-effects del pipeline (Drive move, lock, etc.).

## 10. Componentes / archivos

| Archivo | Responsabilidad | Acción |
|---|---|---|
| `src/lib/testbench.ts` | Lógica pura: `runLogicalPipeline` + `compareToExpected` + tipos | **Crear** |
| `src/lib/testbench.test.ts` | Tests de la lógica (resultado por camino + comparación ground truth) | **Crear** |
| `scripts/llm-testbench.ts` | CLI: lee carpeta, carga directorio, corre, escribe reportes | **Crear** |
| `.gitignore` | Ignorar `pruebas de LLMs/` | Modificar |
| `docs/progreso.md`, `decisiones.md`, `CHANGELOG.md` | Documentación | Modificar |

## 11. Verificación

`npm test` (incluye los tests nuevos de `testbench.ts`) + `npm run typecheck` + `npm run lint`.
El CLI se verifica corriéndolo sobre la carpeta de pruebas (con y sin `expected.json`). Sin
migración de DB.
