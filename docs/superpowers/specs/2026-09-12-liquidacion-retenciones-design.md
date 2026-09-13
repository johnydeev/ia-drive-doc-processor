# Liquidación de retenciones: el paquete que arma la administración

**Fecha:** 2026-09-12
**Estado:** diseño aprobado en conversación, pendiente de plan
**Reemplaza parcialmente:** `2026-09-11-vep-retencion-design.md` (§3.5, §3.6, §4.2, §4.3 quedan sin
efecto; ver §6 de este documento)

---

## 1. Problema

Cuando el consorcio le retiene a su empresa de seguridad o limpieza, la administración arma un
**paquete PDF de 3 a 5 páginas** y lo sube aparte de la factura:

| Pág. | Contenido | Qué aporta |
|---|---|---|
| 1 | **Planilla propia de la administración** (formato fijo) | CUIT del consorcio, **nombre y CUIT de la empresa**, nro. de factura, `IMPORTE TOTAL`, una línea por retención, `SUBTOTAL RETENCIONES`, `IMPORTE NETO` |
| 2 | SICORE — certificado de Ganancias | código 217; "Sujeto Retenido" = la empresa |
| 3 | F.2005 — certificado SIRE IVA | código **216** |
| 4 | F.2004 — certificado seg. social | código 353 |
| última | VEP consolidado | Nro. VEP, Día de Expiración, `Importe total a pagar` = subtotal de retenciones |

Dogo (Pueyrredón) viene en 3 páginas: planilla, SICORE IVA (código 767) y VEP.

**La factura de la empresa se sube en otro PDF**, como siempre. El paquete NO es la factura.

### 1.1 Lo que hace el pipeline hoy, verificado con el extractor real

`identifyLSPProvider` → `null` (el marcador del VEP está en la última página, no en los primeros 200
caracteres); triage → `boleta`. Va a la IA como **factura común**, que ve la página 1 y el primer
certificado (el recorte de 80 líneas no llega al VEP). La IA devuelve empresa + CUIT + **nro. de
factura + importe total**. Resultado: una boleta fantasma de la empresa por el total de la factura.

**Ya pasó.** En la base hay 10 boletas nacidas de paquetes de meses anteriores:

- 7 con detalle `PAGO CORRESPONDIENTE AL MES DE…` (el encabezado de la planilla) por el importe
  total: Mayoral 05 y 06, Aseclim 05, 06 y 08, G4S 05, Libres 08. Cinco de ellas duplican la factura
  real, que había entrado con el número en otro formato (`B-00003-…` vs `00003-…`), así que el dedup
  no las frenó.
- 3 a nombre de **la administradora** (19/08): certificados sueltos con los montos del VEP de Callao
  ($1.439.990,90 y $822.851,94) y de Boedo ($407.902,84).

### 1.2 Lo que confirma el paquete

- La empresa retenida **sí está en el papel**: página 1 con CUIT, y los certificados la repiten. La
  regla del ALTA (`VEP RETENCION` → empresa) que se diseñó ayer para el VEP suelto **no hace falta**
  para el paquete.
- **Un consorcio retiene a más de una empresa** (Boedo 414: Aseclim y Mayoral, mismos regímenes). La
  hipótesis "una empresa por consorcio" duró un día. Con el paquete no importa: cada uno dice la suya.
- Hay **dos códigos de IVA**: 767 (SICORE, Dogo) y 216 (SIRE, los otros tres). Ayer sólo se cargó 767.

---

## 2. Decisión

1. **Tipo nuevo `LIQ_RETENCION`** en el router, detectado por marcadores de la página 1 que ninguna
   factura trae. **Una boleta por paquete, por la retención**, a nombre de la empresa, sin llamar a
   la IA: la planilla es un formato fijo de la administración y todo sale por regex.
2. **El VEP de retención suelto ya no se intenta imputar.** Va a Revisión sin IA con una etiqueta que
   pide el paquete completo. Se retira toda la plomería de `LspService` para retenciones que se
   agregó ayer (fila `VEP RETENCION` del ALTA, etiqueta del modal, rama del fast-path). El VEP del
   **encargado** no cambia.
3. **Certificado de retención suelto** (SICORE / F.2004 / F.2005 sin planilla): no es boleta. Triage
   capa 0 → `[NO BOLETA - CERTIFICADO RETENCION]` a Sin Asignar. Es lo que generó las 3 boletas a
   nombre de la administradora.

### 2.1 Alternativas descartadas

- **Prompt propio para el paquete.** La página 1 es una planilla fija; la IA no aporta nada y el
  recorte de 80 líneas ni siquiera ve el VEP. Regex: 0 requests, determinístico, testeable con los
  4 PDFs reales.
- **Registrar también la factura desde el paquete.** La factura entra por su propio PDF. Sacarla
  del paquete es exactamente el fantasma de §1.1.
- **Mantener la fila `VEP RETENCION` del ALTA como camino paralelo.** No puede distinguir dos
  empresas del mismo consorcio, y el paquete lo resuelve sin ella. Dos caminos para lo mismo es
  deuda.

---

## 3. Diseño

### 3.1 Router — `identifyLSPProvider`

`LSPProvider` suma `"LIQ_RETENCION"`. Se evalúa **antes** de `isVep` (el paquete termina en un VEP)
y antes del LSD y los sindicales, sobre el texto completo en mayúsculas:

```ts
const LIQ_RETENCION_MARKERS = ["SUBTOTAL RETENCIONES", "IMPORTE NETO", "NOMBRE DEL PROVEEDOR"];
function isLiqRetencion(upper: string): boolean {
  return LIQ_RETENCION_MARKERS.every((m) => upper.includes(m));
}
```

Los tres juntos no aparecen en ninguna factura ni en un VEP; sí en las 4 planillas reales.

`textExtractStep` hoy re-extrae **sólo la página 1** para todo LSP (`lspMaxPages`). Para
`LIQ_RETENCION` se conserva el texto completo (`lspMaxPages = undefined`): el Nro. VEP y el
vencimiento están en la última página.

### 3.2 Extracción determinística — `src/lib/liqRetencion.ts`

```ts
export interface LiqRetencion {
  consortiumCuit: string;        // dígitos — 1er "C.U.I.T. N*" de la planilla
  providerName: string | null;   // "NOMBRE DEL PROVEEDOR:"
  providerCuit: string;          // dígitos — 2º "C.U.I.T. N*"
  invoiceNumber: string | null;  // "FACTURA B N*:" (sin la letra)
  invoiceTotal: number | null;   // "IMPORTE TOTAL:"
  lines: Array<{ label: string; amount: number }>;  // IVA / GANANCIAS / SEGURIDAD SOCIAL
  subtotal: number;              // "SUBTOTAL RETENCIONES"
  vepNumber: string | null;      // "Nro. VEP" o "Nro. VEP Consolidado" (última página)
  expiresOn: string | null;      // "Día de Expiración" YYYY-MM-DD
}

/** null si falta alguno de: los dos CUIT válidos, el subtotal. */
export function parseLiqRetencion(text: string): LiqRetencion | null;

/** Lo que el pipeline persiste. */
export function toExtractedDocument(liq: LiqRetencion): ExtractedDocumentData;
```

Reglas de `toExtractedDocument`:

| Campo | Valor |
|---|---|
| `provider` | `providerName` |
| `providerTaxId` | `providerCuit` formateado `XX-XXXXXXXX-X` |
| `consortium` | null (se resuelve por CUIT) |
| `allTaxIds` | `[consortiumCuit, providerCuit]` — **sólo esos dos**; el CUIT de la administradora está en el VEP y no debe entrar |
| `amount` | `subtotal` |
| `boletaNumber` | `vepNumber`; si no se leyó, `RET-<invoiceNumber>` |
| `dueDate` | `expiresOn` |
| `detail` | `Retenciones s/fra. <invoiceNumber> · IVA 642.557,74 · Ganancias 121.048,55 · Seg. Social 367.175,85` |
| `observation` | `Factura <invoiceNumber> $<invoiceTotal> · neto <subtotal restado>` |
| `clientNumber`, `paymentMethod`, `alias` | null |
| `isBoleta` | true |

Los montos vienen en formato es-AR (`1.130.782,14`); parsear con `normalizeBusinessAmount` o
equivalente de `lib/businessKey.ts`, no con un parser local. Los CUIT se validan con
`extractCuitsFromText` (checksum): si el 2º no valida, `parseLiqRetencion` devuelve null y el
documento sigue al camino normal (terminará en Sin Asignar por CUIT de proveedor).

`boletaNumber` = Nro. VEP y no el nro. de factura **a propósito**: el dedup por business key y la
vista de boletas del consorcio tienen que ver dos documentos distintos (factura y retención) y no
uno repetido.

### 3.3 Paso nuevo — `liqRetencionExtractStep`

Va **antes de `aiExtractStep`** en el array de `runPipeline` (después de `vepReviewGate`, §3.5):

- Si `ctx.lspProvider !== "LIQ_RETENCION"` → continue.
- Si `ctx.existingByHash?.extraction` → continue (duplicado: `aiExtractStep` reusa lo guardado).
- `parseLiqRetencion(ctx.docText)`; si null → log `⚠️ LIQ RETENCION no parseable → cadena de IA` y
  continue (la IA lo trata como factura común; peor caso conocido, no se pierde).
- Si parsea: `ctx.extracted = toExtractedDocument(liq)`, `ctx.fileAiUsage = null`,
  `m.lsp = "LIQ_RETENCION"`, `m.ai = { provider: "deterministic", model: null, ok: true, … }`,
  `m.extracted = {…}` como en `aiExtractStep`. Log `📋 Liquidación de retenciones: <empresa>
  s/fra. <nro> — $<subtotal> (0 requests)`.

`aiExtractStep` gana un guard al inicio: `if (ctx.extracted) return { kind: "continue" }`. Es el
único cambio ahí.

### 3.4 Asignación

Sin cambios de código en `resolveAssignment` más allá de:

- `consortiumCuitOnly` incluye `LIQ_RETENCION` (la planilla trae dirección, pero el CUIT es más
  confiable y es lo que se hace con todo lo demás).
- El proveedor sale por **CUIT** (`allTaxIds` menos el del consorcio) → la empresa, si está en el
  directorio. Las 4 de hoy están (Mayoral, Aseclim, Shomer, Dogo). Si no está → Sin Asignar con la
  etiqueta del grupo LSP, **`PROVEEDOR SIN REGISTRAR`** (`provider_not_registered`): las etiquetas
  por CUIT del 2026-08-26 son sólo para `isPlainInvoice`, y `LIQ_RETENCION` no lo es. El fallback
  del código de barras corre (0 tokens, no encuentra nada); el visual no (`cuitMissing` es false).
- `clientNumber` es null, así que el fast-path de `LspService` no corre.
- `cuitSanitizeStep` sólo actúa con `lspProvider === null`: no reinyecta el CUIT de la administradora.

### 3.5 VEP de retención suelto → Revisión

`vepMixtoGate` pasa a llamarse **`vepReviewGate`** y cubre `VEP_MIXTO` **y `VEP_RETENCION`**:

| `lspProvider` | `classifyVep` | Etiqueta | `reasonCategory` |
|---|---|---|---|
| `VEP_MIXTO` | `MIXTO` | `[VEP MIXTO]` | `vep_mixto` |
| `VEP_MIXTO` | `DESCONOCIDO` | `[VEP SIN CLASIFICAR]` | `vep_desconocido` |
| `VEP_RETENCION` | `RETENCION` | `[VEP RETENCION SUELTO - SUBIR LIQUIDACION COMPLETA]` | `vep_retencion_suelto` |

Revisión (`failed`), 0 requests. El VEP suelto no dice a quién se le retuvo y no se adivina.

`VEP_RETENCION_CODES` suma `"216"`.

### 3.6 Certificado suelto → capa 0 del triage

`detectDecisiveNotBoleta` (hoy vacía) vuelve a tener un caso:

```ts
// Certificado de retención/percepción sin la planilla: no hay nada que pagar.
if (upper.includes("DATOS DEL AGENTE DE RETENCI") && upper.includes("DATOS DEL SUJETO RETENIDO")) {
  return "CERTIFICADO RETENCION";
}
```

Sólo se evalúa si el router **no** devolvió `LIQ_RETENCION` (`documentTriageGate` ya corre después
del router; se agrega el guard — sin él, el paquete completo caería acá porque conserva el texto de
los certificados). `NotBoletaKind` pasa de `never` a `"CERTIFICADO RETENCION"`; `divertNotBoleta`
ya arma `[NO BOLETA - <kind>]`. Etiqueta `[NO BOLETA - CERTIFICADO RETENCION]`, Sin Asignar, 0
requests.

Verificado con el texto real: las líneas de la planilla salen de pdf-parse **una por línea y con el
monto en la misma línea** (`SUBTOTAL RETENCIONES 1.130.782,14`, `IVA 642.557,74`,
`FACTURA B N*: 00001-00001848`, `C.U.I.T. N* 30-54675623-4`), y el VEP trae `Nro. VEP Consolidado:
1679299135` / `Nro. VEP: 1679256980` y `Día de Expiración: 2026-10-10`. Los regex de §3.2 van sobre
ese formato.

### 3.7 Se retira (de ayer)

- `LSP_ROUTER_TO_CANONICAL["VEP_RETENCION"]`, `LSP_FALLBACK_NAMES["VEP_RETENCION"]`,
  `VEP_RETENCION_KEYWORD`.
- El bloque de `VEP_RETENCION` en `cleanClientNumberStep`.
- `providerFromLspRow`, la rama `vep_retencion_not_registered` y su etiqueta en
  `resolveAssignment` / `UNASSIGNED_TAG_BY_CATEGORY`.
- La rama `VEP RETENCION` de `directorySync.service.ts` y la etiqueta en `availableTargets.ts`.
- `extractVepContribuyenteCuit` queda (sigue siendo la forma correcta de leer el CUIT del VEP; la
  usa `parseLiqRetencion` para la última página).
- Sus tests: se borran los que prueban el camino retirado; se reescriben como §5.

---

## 4. Operación

### 4.1 Limpieza de las 10 boletas fantasma (owner)

Las 7 `PAGO CORRESPONDIENTE AL MES DE…` y las 3 de la administradora. Dos caminos:

- **Borrar desde la pestaña Boletas del consorcio** → el PDF va a **Revisión** y no se reprocesa.
  Recomendado para las de mayo–agosto: su período ya cerró y reprocesarlas las metería en septiembre.
- **Borrar desde Boletas entrantes** → vuelve a Pendientes y se reprocesa como `LIQ_RETENCION`.
  Sólo para las de un período todavía activo.

### 4.2 ALTA

Nada que cargar. Si el owner ya creó filas `VEP RETENCION` en `_LspServices`, borrarlas: sin la
rama del sync, el próximo sync las trataría como un servicio de un proveedor inexistente.

---

## 5. Tests

`src/lib/liqRetencion.test.ts` (nuevo) — fixtures = texto pdf-parse de los 4 paquetes reales
(Mayoral, Aseclim, Shomer, Dogo), guardados como constantes en el test:

- `parseLiqRetencion`: los 4 parsean; consorcio/empresa/factura/subtotal/VEP/vencimiento exactos
  (`1130782.14`, `1679299135`, `2026-10-10`…); Dogo (3 páginas, código 767) también.
- Devuelve null si falta el subtotal; null si el CUIT de la empresa no pasa checksum.
- `toExtractedDocument`: `allTaxIds` tiene exactamente 2 CUIT (no el de la administradora, que está
  en el texto); `boletaNumber` = Nro. VEP; fallback `RET-<factura>` sin VEP; `amount` = subtotal.

`src/lib/extraction.test.ts`: los 4 paquetes → `LIQ_RETENCION`; una factura común con la palabra
"retención" en el detalle → `null`; el VEP suelto de retención sigue → `VEP_RETENCION`.

`src/lib/documentClassifier.test.ts`: certificado F.2004 suelto → `CERTIFICADO RETENCION`; el
mismo texto dentro de un paquete no se evalúa (guard por `lspProvider`).

`src/jobs/processPendingDocuments.job.test.ts` (caracterización):
- Paquete con empresa registrada → **0 requests** (`aiChain.run` no llamado), boleta al consorcio
  del 1er CUIT, proveedor = empresa, `amount` = subtotal, `boletaNumber` = Nro. VEP, la
  administradora **no** aparece aunque su CUIT esté en el texto.
- Paquete con empresa no registrada → Sin Asignar `PROVEEDOR SIN REGISTRAR`, sin llamar a Vision.
- Paquete no parseable (sin subtotal) → sigue a la IA (1 request), no rebota.
- Paquete duplicado por hash → reusa la extracción, 0 requests, va a Duplicados.
- VEP de retención suelto → Revisión `[VEP RETENCION SUELTO…]`, 0 requests, `vep_retencion_suelto`.
- Certificado suelto → `[NO BOLETA - CERTIFICADO RETENCION]`, Sin Asignar, 0 requests.
- VEP del encargado → sin cambios (los tests de ayer siguen verdes).

`directorySync.service.test.ts` y `availableTargets.test.ts`: se quitan los tests de `VEP RETENCION`.

---

## 6. Relación con el spec del 2026-09-11

Sigue vigente: `classifyVep` y los códigos (con 216), el router `VEP` / `VEP_RETENCION` /
`VEP_MIXTO`, `extractVepContribuyenteCuit`, el renombre `ARCA` → `ARCA EMPLEADO`, el gate de
Revisión para mixto/desconocido. Queda sin efecto todo lo que hacía que `VEP_RETENCION` entrara por
`LspService` (§3.5, §3.6, §4.2, §4.3 de ese spec). Se anota ahí con una nota al inicio.

## 7. Fuera de alcance

- Vincular la boleta de retención con la factura a la que corresponde (hoy sólo por el nro. en el
  detalle).
- Gasto fijo "retención de X": el owner decidió no cargarlos por ahora.
- Paquetes escaneados (imagen): los 4 reales son digitales; si llega uno escaneado, el OCR decide
  si los marcadores se leen y si no, sigue a la IA como factura común (peor caso de §1.1).
