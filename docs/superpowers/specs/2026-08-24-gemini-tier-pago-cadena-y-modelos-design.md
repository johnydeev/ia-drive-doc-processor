# Gemini como proveedor principal: cadena, modelos y verificación

**Fecha:** 2026-08-24
**Estado:** spec aprobado, sin implementar
**Origen:** el owner va a contratar una cuenta paga de Gemini. Antes de cambiarla en
producción hay que saber si la cuota alcanza, cuánto cuesta, y qué cambios de código pide
el pasaje de free tier a tier pago.

---

## 1. Medición previa (hecha, no es propuesta)

Sobre `TokenUsage` de producción (proyecto `invoices-ia-automation`), 2026-03-27 → 2026-08-21.

Las filas de `TokenUsage` con `provider = 'aggregate'` son el total por corrida; las de
`provider = '<nombre>'` son el desglose. La suma cierra exacta
(4.045.378 input = 2.965.694 de Gemini + 1.079.684 de Cerebras), así que `aggregate` se usa
como unidad "una boleta procesada por IA".

| Métrica | Valor |
|---|---|
| Corridas de IA | 1.363 en 77 días con actividad |
| Resueltas por Gemini | 1.049 (77%) |
| Resueltas por Cerebras | 315 (23%) |
| Boletas/día promedio | 17,7 |
| Boletas/día p95 | 53,8 |
| Boletas/día pico | 72 (2026-05-21) |
| **Pico de requests por minuto** | **4** (promedio 1,30; solo 2 minutos de 1.065 pasaron de 3) |
| Tokens promedio por boleta en Gemini | 2.827 input / 260 output |

El RPM bajo no es casualidad: el worker procesa un job a la vez. No hay concurrencia que
pueda empujar el RPM salvo que se agreguen workers.

**Precio del tier pago** (verificado en `ai.google.dev/gemini-api/docs/pricing` el 2026-08-24):

| Modelo | Input /1M | Output /1M |
|---|---|---|
| `gemini-2.5-flash-lite` | US$ 0,10 | US$ 0,40 |
| `gemini-2.5-flash` | US$ 0,30 | US$ 2,50 |

**Proyección de costo mensual**, si el 100% de las boletas fuera por Gemini:

| Escenario | flash-lite | flash |
|---|---|---|
| Mes pico observado (375 boletas) | US$ 0,15 | US$ 0,56 |
| Agosto 2026 real (247 boletas) | US$ 0,10 | US$ 0,37 |
| 10× el volumen actual (3.750/mes) | US$ 1,45 | US$ 5,60 |

**Conclusión: ni la cuota ni el costo son el problema.** El problema es que el free tier
tiene tope diario por modelo (~20 requests), y todo el diseño del barrido de modelos existe
para esquivarlo.

**Límite de la medición:** `extractPartiesFromImage` (el fallback visual) no registra
tokens — ver pieza 5. Si sostiene la proporción observada el 2026-08-18 (2 de 8 jobs), el
consumo real está subestimado ~25%. Aun al doble, sigue por debajo de un dólar mensual.

Los límites RPM/TPM exactos del tier pago ya no están en la doc pública: Google los movió a
la consola por cuenta (`aistudio.google.com/rate-limit`). Con un pico medido de 4 RPM, no
hay tier publicado que quede cerca.

---

## 2. Estado actual del código

**La key de Gemini es editable por UI.** Vive en `extractionConfigJson.geminiApiKey` de
MorinigoAdm, encriptada, con campo propio en `/admin/clients/[id]`. Cambiarla **no requiere
deploy ni reiniciar contenedores**. La de Cerebras no: solo sale de `env.CEREBRAS_API_KEY`.

**El orden de la cadena es implícito.** `createAiExtractionChain`
(`src/services/aiExtraction.ts:111`) lo define por el orden físico de cinco bloques `if`:
Cerebras → Groq → Gemini → OpenAI → Claude. Leer el orden exige leer 45 líneas.

**El barrido de modelos es una estrategia de free tier.** `DEFAULT_MODEL_CANDIDATES`
(`src/services/geminiExtractor.service.ts:28`) lista 5 modelos y el comentario explica por
qué: en free tier la cuota es diaria **por modelo**, así que barrer suma baldes. Dos de esos
cinco (`gemini-2.0-flash`, `gemini-2.0-flash-lite`) devuelven 404 desde hace tiempo.

**`callWithRetry` existe, tiene 6 tests y ningún consumidor en producción**
(`src/lib/aiErrors.ts:68`). Reintenta solo ante 429 y termina lanzando `RateLimitError`.

---

## 3. Las seis piezas

### Pieza 1 — Orden de la cadena explícito

Los cinco bloques `if` de `createAiExtractionChain` pasan a un array de definiciones
(`provider` + cómo construir el extractor) que la función recorre. El orden queda declarado
en un solo lugar y mover un proveedor es editar una línea.

Orden nuevo: **`gemini → cerebras → openai → anthropic`**. Groq sigue soportado y fuera de
producción, como hoy.

El test existente que fija `providerOrder` en `cerebras → groq → gemini → openai` se invierte
al orden nuevo.

### Pieza 2 — Poda de modelos muertos

`DEFAULT_MODEL_CANDIDATES` pasa de 5 a 3: se van `gemini-2.0-flash` y
`gemini-2.0-flash-lite`. Quedan `gemini-2.5-flash-lite`, `gemini-2.5-flash`,
`gemini-flash-latest`.

El comentario del barrido se reescribe: hoy documenta la aritmética de baldes del free tier,
que deja de aplicar. La razón de conservar un barrido corto pasa a ser otra — ver pieza 3.

### Pieza 3 — El 503 reintenta el mismo modelo antes de degradar

Clasificador nuevo `isTransientServerError` en `src/lib/aiErrors.ts`: reconoce 503,
`UNAVAILABLE`, "overloaded" y "high demand". Vive al lado de `isRateLimitError` y sigue su
mismo criterio: clasificar sobre el objeto del error (status numérico primero, texto
después), nunca reparseando el mensaje aguas arriba.

En el barrido de `extractStructuredData`, un 503 reintenta **ese mismo modelo** una vez, tras
esperar 2000 ms, antes de saltar al siguiente. Hoy salta de una: por eso una boleta que le
tocaba `2.5-flash-lite` termina resuelta por un modelo distinto.

El valor va en una constante con nombre, no literal, y la espera se inyecta como parámetro
(`sleep`) igual que en `callWithRetry`, para que el test no espere de verdad. Un solo
reintento: dos sumarían 4 s por modelo y el peor caso ya son los 187 s medidos el 2026-08-18.

**Por qué no se elimina el barrido:** el 503 `This model is currently experiencing high
demand` no desaparece en tier pago. El 2026-08-18 fue justamente el barrido lo que salvó una
boleta (flash-lite dio 503, siguió a otro modelo). El barrido se acorta, no se saca.

**Por qué no se reusa `callWithRetry`:** su contrato termina en `RateLimitError`, que en el
pipeline significa "devolver la boleta a Pendientes". El 503 necesita degradar de modelo,
no rendirse. Reusarlo obligaría a cambiar su semántica y romper sus 6 tests.

### Pieza 4 — Un 503 en todos los modelos devuelve la boleta a Pendientes

`throwSweepFailure` (`src/services/geminiExtractor.service.ts:86`) solo lanza `RateLimitError`
cuando **todos** los errores del barrido son 429. Con todo en 503 lanza `Error` genérico, y
el pipeline manda a **Revisión** una boleta sana por una caída de capacidad de Google.

La condición se extiende a "todos transitorios (429 **o** 503)". Es un bugfix, no una mejora
de estilo: hoy una boleta correcta termina en revisión manual por un problema de minutos del
lado de Google.

### Pieza 5 — El fallback visual entra en la medición

`extractPartiesFromImage` (`src/services/geminiExtractor.service.ts:163`) actualiza
`workingModelName` pero nunca llama a `captureUsage`. Es el único camino que consume tokens
sin registrarlos: `extractStructuredData` y `extractStructuredDataFromImage` sí lo hacen.

Se agrega la llamada a `captureUsage`. Sin esto no se puede verificar cuánto gasta realmente
la cuenta paga, porque el fallback visual es una llamada multimodal por boleta rebotada.

### Pieza 6 — El modelo pegajoso no puede fijarse en el modelo caro

`GeminiExtractorService.workingModelName` es `static`, compartido por todas las instancias
del proceso, se setea solo al tener éxito y no expira.

Escenario real: `2.5-flash-lite` da 503 → el barrido salta a `2.5-flash` → funciona → **el
worker arranca todas las boletas siguientes con `2.5-flash` hasta que alguien lo reinicie.**

En free tier eso era deseable (no volver a pegarle a un balde agotado). En tier pago es
deriva de costo silenciosa: `2.5-flash` sale 3× el input y 6× el output de flash-lite.

**Decisión: el pegado se aplica solo cuando el salto anterior fue por cuota (429), no por
error transitorio (503).** Si flash-lite dio 503 y flash resolvió, `workingModelName` no se
actualiza y la boleta siguiente vuelve a arrancar por flash-lite. Si flash-lite dio 429, el
pegado sí corresponde: la cuota no se recupera en la boleta siguiente.

Descartado: hacer que el modelo pegado expire a los N minutos. Introduce tiempo en el estado
—y por lo tanto un test que depende del reloj— para cubrir un caso que 429 y 503 ya cubren
entre los dos.

---

## 4. Lo que NO entra

- Config nueva por cliente (`providerOrder` editable). Con **un solo cliente real** es
  configuración a validar, versionar y mantener para un caso que hoy no existe.
- Flag `geminiTier: free | paid`. No cambiaría ninguna decisión de código que el array de
  3 modelos no cubra ya.
- Migración de base de datos. Ninguna pieza toca el schema.
- UI. Ninguna pieza toca el panel.
- Tocar `callWithRetry` (ver pieza 3).
- Mover Cerebras fuera de la cadena. Queda segundo. El 402 por cuota agotada se trata aparte.

---

## 5. Verificación

### 5.1 Qué verifica qué

El testbench arma los extractores sueltos desde el entorno (`scripts/llm-testbench.ts:34`) y
**no usa `createAiExtractionChain`**: no prueba el orden de la cadena. El reparto:

| Pieza | Cómo se verifica |
|---|---|
| 1 · Orden de cadena | Test unitario de `providerOrder` (se invierte el existente) |
| 2 · Poda de modelos | Test unitario + el `usage.model` del reporte del testbench muestra cuál respondió |
| 3 · Reintento del 503 | Test con extractor falso: 503 la primera, OK la segunda, `sleep` inyectado (patrón ya usado en `aiErrors.test.ts`) |
| 4 · 503 total → Pendientes | Test: todos 503 → `RateLimitError`, no `Error` |
| 5 · `captureUsage` en fallback visual | Test unitario + en producción, que aparezcan filas de `TokenUsage` tras una boleta que use el fallback |
| 6 · Modelo pegajoso | Test de que tras un salto por 503 no queda fijado el modelo caro |

Más la verificación completa del proyecto: `npm run typecheck` + `npm run lint` +
`npx vitest run` + `npm run build` + `npm run build:jobs`.

### 5.2 Prerrequisito: poppler en el host

El OCR invoca `pdftoppm` por `execSync` (`src/services/ocr.service.ts:42`). La imagen de
producción lo tiene, **el Windows del owner no**. Y la imagen de producción trae solo
`dist/`: sin `src/`, sin `scripts/`, sin `tsx`, así que el testbench tampoco corre adentro
del contenedor.

Consecuencia actual: **el testbench local no puede probar ninguna boleta escaneada ni de
membrete en imagen** — justo los caminos que motivan el cambio (Vision y fallback visual).
Ya estaba anotado como limitación conocida en `docs/progreso.md` (2026-08-17).

**Acción del owner:** instalar poppler para Windows y ponerlo en el PATH. Un binario, sin
Docker y sin cambios de código. Desbloquea también `scripts/diag-boleta.ts` y
`scripts/dump-pdf-text.ts`, que hoy tampoco sirven para esos PDFs.

Verificación de que quedó bien: `pdftoppm -v` responde, y correr el testbench sobre una
boleta escaneada conocida imprime `[ocr-service] pdftoppm generó N página(s)` en vez de
avisar que no hay texto.

### 5.3 El lote fijo de regresión

15-25 boletas en una carpeta local, cada una con su `<boleta>.expected.json` escrito **a
mano** una vez, mirando el papel. Formato (`ExpectedFields`, `src/lib/testbench.ts:164`):

```json
{
  "consortium": "BARTOLOME MITRE 1225",
  "provider": "PINTO ESCALIER ARTURO ADOLFO",
  "providerTaxId": "20-12945605-2",
  "amount": 35091,
  "dueDate": "2026-06-18",
  "boletaNumber": "0004-00034781",
  "result": "ok"
}
```

Todos los campos son opcionales: los ausentes se reportan `absent` y no cuentan.
`compareToExpected` compara CUIT por dígitos, monto normalizado y el resto por texto
insensible a mayúsculas, y devuelve `hits/total`.

Composición, para que cubra caminos distintos y no 20 facturas iguales:

| Cantidad | Tipo | Qué camino cubre |
|---|---|---|
| 5-6 | Texto directo, membrete legible | Regresión: que lo que anda siga andando |
| 3-4 | Servicios (Edesur / AySA / Metrogas) | Router LSP |
| 2 | Sindicales o ARCA | Grupo "CUIT del papel = consorcio" |
| 3-4 | Escaneadas puras (`FB0004-*`) | Rama de Gemini Vision |
| 3-4 | Membrete en imagen (GESTIONPRO) | Fallback visual — pendiente abierto |
| 1-2 | No son boleta (pedido PATAGONIA, estado de cuenta) | Que el triage las siga rechazando |

Los PDFs se bajan de Drive a mano, una sola vez. El lote queda como red de regresión para
cualquier cambio futuro de modelo o de prompt, no solo para esta entrega.

**Limitación conocida del lote:** `runLogicalPipeline` (`src/lib/testbench.ts:67`) hace
triage → IA → gate de monto → CUITs → matching → canonización. **No** hace el fast-path de
`LspService` por número de cliente, ni el código de barras AFIP, ni el fallback visual, ni
dedup, ni Sheets, ni movimiento de archivos. Mide **calidad de extracción y matching**, no el
pipeline entero. Para las boletas de servicio esto significa que el testbench puede reportar
`provider_not_found` donde el pipeline real resuelve por número de cliente (hallazgo del
2026-08-17): su veredicto no es confiable para LSP y hay que leerlo sabiéndolo.

### 5.4 La comparación que decide

Correr el testbench dos veces sobre el mismo lote:

1. Con la key free actual en `GEMINI_API_KEY` del `.env` local.
2. Con la key paga.

Salen dos `reporte.md` con `hits/total` por modelo. La conclusión que interesa es **cuál de
dos cosas pasó**: la cuenta paga mejora la extracción, o solo saca los 429 y la calidad es la
misma. Son decisiones distintas sobre qué hacer después con Cerebras.

### 5.5 Aislamiento

El testbench **no escribe Drive, ni Sheets, ni DB**. De la base solo lee `Consortium` y
`Provider` para armar el directorio. Escribe únicamente
`<carpeta>/_resultados/<AAAA-MM-DD_HH-MM>/{resultados.json,reporte.md}`.

La key paga entra a producción recién cuando el owner decida, pegándola en el panel del
cliente. Revertir es pegar la vieja: sin deploy, sin reinicio.

---

## 6. Riesgos

| Riesgo | Mitigación |
|---|---|
| Gemini primero degrada la calidad respecto de Cerebras | Es exactamente lo que mide 5.4 antes de tocar producción. Cerebras queda segundo: si Gemini falla, la boleta sigue entrando |
| El reintento del 503 alarga el tiempo por boleta | Un reintento con espera corta contra los ~8,5 s/boleta actuales. El peor caso hoy ya son los 187 s medidos el 2026-08-18 cuando el barrido recorrió cinco modelos |
| La poda deja el barrido corto y los 3 modelos 503 a la vez | Pieza 4: la boleta vuelve a Pendientes y se reintenta, en vez de ir a Revisión |
| El owner no llega a instalar poppler | Las piezas 1-4 y 6 se verifican igual con tests unitarios. Solo queda sin cubrir la comparación de calidad sobre boletas escaneadas |

---

## 7. Documentación a actualizar al terminar

Por la regla obligatoria de `CLAUDE.md`: `docs/progreso.md`, `docs/decisiones.md` y
`CHANGELOG.md`. Además, en `CLAUDE.md`, el orden de la cadena de IA aparece en la descripción
del proyecto y en el paso 4 del pipeline: pasa a decir **Gemini → Cerebras → OpenAI → Claude**.
