# VEP de retención: imputar el cupón a la empresa retenida

**Fecha:** 2026-09-11
**Estado:** diseño aprobado en conversación, pendiente de plan
**Antecedente:** `2026-09-03-vep-arca-como-gasto-design.md` (el VEP como gasto del encargado)

---

## 1. Problema

Un consorcio paga con VEP de ARCA dos cosas distintas:

1. **Cargas sociales del encargado** (DJ F931, ART, seguro de vida). Hoy funciona: proveedor
   `ARCA`, consorcio por el CUIT del contribuyente.
2. **Retenciones practicadas a un tercero** — la empresa de seguridad o de limpieza que le
   factura al consorcio. El consorcio es *agente de retención*: le descuenta a la empresa una
   parte de la factura y se la ingresa a ARCA con un VEP. La administración necesita ver ese
   VEP **a nombre de la empresa retenida** (Libres Seguridad en Callao 1441, Dogo en
   Pueyrredón 2418), no de ARCA, para saber a quién se le retuvo y que cierre contra su
   factura.

Hoy el segundo caso entra bien al edificio pero sale a nombre de `ARCA`, indistinguible del
primero.

### 1.1 Lo que dice el papel (3 rendiciones de julio 2026 leídas página por página)

| Consorcio | Tipo de Pago | CUIT impreso | Renglones (código) | Total |
|---|---|---|---|---|
| Callao 1441 | Empleadores SICOSS - Saldo DJ | 30-70200241-5 (consorcio) | 351 · 301 · 352 · 302 · 312 · 28 | $2.188.815,06 |
| Callao 1441 | Vep Consolidado ARCA | 30-70200241-5 (consorcio) | 217 · 767 · 353 | $2.535.783,44 |
| Pueyrredón 2418 | Empleadores SICOSS - Saldo DJ | 30-71001560-7 (consorcio) | SICOSS | $2.434.378,85 |
| Pueyrredón 2418 | Vep Consolidado ARCA | 30-71001560-7 (consorcio) | 312 (ART) | $609.793,62 |
| Pueyrredón 2418 | Retenciones IVA - Pago a cuenta | 30-71001560-7 (consorcio) | 767 | $620.786,70 |
| Carabobo 37 | — (sin empleado: ningún VEP, ningún ARCA) | | | |

Tres hechos que fijan el diseño:

- **Todo VEP imprime el CUIT del consorcio**, también los de retención. La empresa retenida
  **no figura en el VEP**: sólo en el F.2004 (certificado de retención), que es otro papel.
  La regla "el VEP de retención va con el CUIT de la empresa" que dio la administración es
  incorrecta; el papel la contradice.
- `Tipo de Pago`, `Descripción Reducida` y `Concepto` **no sirven** para distinguir: un
  "Vep Consolidado ARCA / VCON#n / VEP CONSOLIDADO" puede ser retenciones (Callao) o la ART
  del encargado (Pueyrredón p12), con los tres campos idénticos.
- **Lo único consistente son los códigos de impuesto de los renglones**, numeración de
  ARCA, estable entre meses y cupones.

### 1.2 Códigos de impuesto

| Grupo | Códigos | Qué son |
|---|---|---|
| **Encargado** | 351, 301, 352, 302, 312, 28 | Contribuciones y aportes SICOSS, obra social, ART (Ley 24557), seguro de vida colectivo |
| **Retención** | 217, 767, 353 | SICORE Ganancias · SICORE/SIRE retenciones y percepciones IVA · retención de contribuciones de seguridad social (régimen de empresas de seguridad y limpieza) |

Los códigos identifican el **régimen**, no la empresa. Si un consorcio retuviera a dos
empresas del mismo régimen, el VEP no las separa. Decisión del owner: **una empresa retenida
por consorcio, por ahora**; un segundo caso se resuelve cuando aparezca.

---

## 2. Decisión

Modelar la regla "en este edificio, las retenciones son a esta empresa" como una fila de
`LspService`, igual que el ABL modela la partida: el pipeline la resuelve por el fast-path que
ya existe, aparece en "Agregar gastos fijos" como servicio del edificio y la obligación
mensual se cumple sola.

### 2.1 Alternativas descartadas

- **Campo nuevo `Provider.retentionForConsortiumId`.** Modelo más limpio, pero exige
  migración, UI de edición de proveedores (hoy el endpoint sólo lista y crea) y una columna
  nueva en el ALTA, para el mismo resultado.
- **Dejarlo en ARCA con etiqueta `[VEP RETENCION]`.** No resuelve el pedido: la boleta
  seguiría sin empresa.
- **Pedirle los códigos a la IA.** Los renglones salen por regex del texto; no hay motivo
  para gastar tokens ni para depender del modelo en algo determinístico.

---

## 3. Diseño

### 3.1 Clasificación del VEP (0 tokens) — `src/lib/vepExtraction.ts`

```ts
export const VEP_EMPLEADO_CODES  = new Set(["351", "301", "352", "302", "312", "28"]);
export const VEP_RETENCION_CODES = new Set(["217", "767", "353"]);

export type VepKind = "EMPLEADO" | "RETENCION" | "MIXTO" | "DESCONOCIDO" | "SIN_CODIGOS";

/** Códigos de impuesto de los renglones: `... (351)  $896.406,81`. */
export function extractVepConceptCodes(text: string): string[];

/** EMPLEADO si sólo hay códigos del encargado; RETENCION si sólo de retención;
 *  MIXTO si hay de los dos; DESCONOCIDO si hay códigos pero ninguno de las dos
 *  listas (ej. un VEP de IIBB); SIN_CODIGOS si no se leyó ningún `(nnn)`. */
export function classifyVep(text: string): VepKind;

/** CUIT rotulado `CUIT:` — el del contribuyente. NO el de "Generado por el Usuario". */
export function extractVepContribuyenteCuit(text: string): string | null;
```

Regex de códigos: `\((\d{2,3})\)` filtrado contra la unión de los dos sets. Regex de CUIT:
`CUIT:\s*(\d{2}-?\d{8}-?\d)` validado con `extractCuitsFromText` (`lib/cuit.ts`). El rótulo
`CUIT:` aparece una sola vez en el VEP; el de la administradora se rotula "Generado por el
Usuario" y no lleva la palabra CUIT.

### 3.2 Router — `identifyLSPProvider` en `src/lib/extraction.ts`

`LSPProvider` suma dos valores: `"VEP_RETENCION"` y `"VEP_MIXTO"`.

```ts
if (isVep(upper)) {
  const kind = classifyVep(text);
  if (kind === "RETENCION") return "VEP_RETENCION";
  if (kind === "MIXTO" || kind === "DESCONOCIDO") return "VEP_MIXTO";
  return "VEP";                       // EMPLEADO o SIN_CODIGOS: comportamiento actual
}
```

`SIN_CODIGOS` cae en `VEP` a propósito: un cupón cuyo OCR no rindió los renglones sigue
entrando como hasta hoy (a nombre de ARCA EMPLEADO), que es el caso mayoritario y el que ya
funciona. No se inventa una retención sin evidencia.

`DESCONOCIDO` también va a Revisión: en Pendientes ya hubo un `VEP IIBB 08-26 BROWN`
(ingresos brutos), que no es ni del encargado ni retención. Imputarlo a ARCA EMPLEADO por
defecto sería un error silencioso; que lo mire una persona.

`LSP_ROUTER_TO_CANONICAL["VEP_RETENCION"] = "VEP RETENCION"` (la palabra fija de la columna
PROVEEDOR del ALTA, §4.2) y `LSP_FALLBACK_NAMES["VEP_RETENCION"] = "VEP RETENCION"` (texto
del proveedor si la fila no tiene empresa). `VEP_MIXTO` no tiene nombre canónico: nunca
llega a asignación.

**Verificado en producción**: los 12 VEP procesados hasta hoy entraron por texto
(`usedVision = false`), son PDFs digitales de ARCA. El regex de códigos no depende del OCR.

### 3.3 Extracción

`VEP_RETENCION` y `VEP_MIXTO` usan **el mismo `buildVepPrompt`** que `VEP` (mismo
`case` en `getPromptForProvider`, `lspMaxPages = 1`). El prompt no cambia. `detail` de la
boleta se completa en código con los códigos leídos (`"Retención · 217 · 767 · 353"`), para
que en la hoja y en la liquidación se vea qué regímenes cubre el cupón.

### 3.4 VEP mixto → Revisión

Paso nuevo `vepMixtoGate`, inmediatamente después de identificar el `lspProvider` (antes
de la IA): si `ctx.lspProvider === "VEP_MIXTO"`, renombra con la etiqueta que corresponda
—`[VEP MIXTO]` si `classifyVep(ctx.docText)` dio `MIXTO`, `[VEP SIN CLASIFICAR]` si dio
`DESCONOCIDO`—, mueve a **Revisión** (`failed`) y halta con `reasonCategory = "vep_mixto"` /
`"vep_desconocido"`, `aiRequests = 0`. Un cupón que mezcla encargado y retención no puede
imputarse a un solo proveedor, y uno de códigos desconocidos no tiene regla; los separa la
administración a mano. Mismo patrón que el consorcio sin período activo (`no_active_period`).

### 3.5 Número de cliente

`cleanClientNumberStep` hoy borra `clientNumber` para todo el grupo `usesConsortiumCuit`.
`VEP_RETENCION` **no entra en ese grupo** (§3.6). En ese mismo paso, si
`ctx.lspProvider === "VEP_RETENCION"`, se fija:

```ts
extracted.clientNumber = extractVepContribuyenteCuit(ctx.docText) ?? null;  // sólo dígitos
```

**Siempre, pisando lo que haya devuelto el modelo.** El spec del 2026-09-03 (§3.2 ter)
documentó que un `Nro. VEP` colado por la IA en `clientNumber` rebota el cupón entero por
el fast-path terminal; `VEP_RETENCION` es el primer VEP que **sí** usa `LspService`, y
justamente por eso su `clientNumber` no puede venir del modelo.

Si no se pudo leer el CUIT rotulado, `clientNumber` queda null y el fast-path no corre: la
boleta sigue al matching normal, donde `consortiumCuitOnly` pasa a cubrir también
`VEP_RETENCION` (no imprime dirección, igual que `VEP`), y sin CUIT termina en Sin Asignar
con `SIN CONSORCIO` — que describe exactamente el problema.

### 3.6 Asignación — `resolveAssignment`

El fast-path de `LspService` ya hace lo necesario si se le dan dos cosas:

1. **No resolver `lspProviderId` por CUIT.** El bloque que busca un proveedor cuyo CUIT esté
   en `allTaxIds` se saltea para `VEP_RETENCION` (además de los sindicales). Sin esto, el
   CUIT de "Generado por el Usuario" —la administradora, proveedor real— resolvería
   `lspProviderId` y el bloque `resolvedProvider = lspProviderId ? {...} : lspService.providerRef`
   imputaría el VEP a la administradora. Es la misma trampa que ya se documentó para `VEP`
   (§3.2 del spec del 2026-09-03), en otro lugar del mismo paso.
2. **`findByProviderName(clientId, "VEP RETENCION", cuitDigits)`** encuentra la fila; el
   proveedor sale de `lspService.providerRef` (la empresa retenida, cargada por el sync desde
   la columna DESCRIPCIÓN, §4.2). Consorcio, período, banco y carpeta de Rendiciones salen de
   la fila, como con cualquier LSP.

Sin fila → el fast-path es terminal y hoy devuelve `lsp_clientnumber_not_registered` /
`LSP SIN REGISTRAR`. Para `VEP_RETENCION` la categoría es propia,
`vep_retencion_not_registered`, etiqueta **`VEP RETENCION SIN EMPRESA REGISTRADA`**, así en
Sin Asignar se lee la acción: cargar la fila del ALTA.

`usesConsortiumCuit` **no** incluye `VEP_RETENCION`: no necesita match de proveedor por
nombre (el proveedor viene de la fila), y el fast-path corre antes que cualquier match de
consorcio. Sí se le aplica el corte de `allTaxIds` al `matchProvider`, por si alguna vez
cae al matching normal: `isVepInvoice` pasa a cubrir `VEP` y `VEP_RETENCION`.

### 3.7 Boleta resultante

| Campo | Valor |
|---|---|
| consorcio | el de la fila `LspService` |
| proveedor | la empresa retenida (`providerRef` de la fila) |
| `lspServiceId` | la fila |
| `provider` (texto) | razón social de la empresa |
| `providerTaxId` | CUIT de la empresa (del `Provider`) |
| `detail` | `Retención · <códigos>` |
| `boletaNumber` | Nro. VEP (o Nro. VEP Consolidado) |
| `clientNumber` (col. J de Sheets) | CUIT del consorcio en dígitos — es lo que la fila usa como clave |
| `paymentMethod` | null |

---

## 4. Alta y operación

### 4.1 Renombre `ARCA` → `ARCA EMPLEADO`

Al proveedor `ARCA` sólo le entran cupones del encargado (DJ, ART, F931). Para que la lista
de gastos fijos lo diga, se renombra. El match del VEP es **por nombre contra
`canonicalName` o `matchNames`** (`allowNameMatch`, nivel 2), y el prompt devuelve
`provider: "ARCA"` fijo, así que basta con dejar `ARCA` como alias:

| RAZÓN SOCIAL | CUIT | NOMBRE FANTASÍA |
|---|---|---|
| ARCA EMPLEADO | *(vacío)* | `ARCA\|AGENCIA DE RECAUDACION Y CONTROL ADUANERO` |

**El sync renombra sólo por CUIT y ARCA no tiene**: cambiar sólo la fila del ALTA crearía un
`ARCA EMPLEADO` nuevo y dejaría `ARCA` como sobrante con sus 2 gastos fijos y 2 boletas. El
panel no edita proveedores. Procedimiento, en este orden:

1. Claude corre, con aviso previo, un `UPDATE "Provider" SET "canonicalName" = 'ARCA EMPLEADO'`
   sobre la fila `ARCA` del cliente (dato, no schema; conserva el `id`, así que los gastos
   fijos, obligaciones y boletas siguen colgando de él y la lista de obligaciones muestra el
   nombre nuevo al instante — resuelve `canonicalName` en vivo por `providerId`).
2. El owner cambia la fila del ALTA como en la tabla, para que el próximo sync la encuentre
   por nombre y no reporte nada.

Lo que no cambia: el texto "ARCA" en la columna B de las boletas viejas de la hoja Datos.

### 4.2 Fila de `_LspServices` por consorcio con retenciones

| NOMBRE CANÓNICO | PROVEEDOR | NRO CLIENTE | DESCRIPCIÓN |
|---|---|---|---|
| CALLAO 1441 | `VEP RETENCION` | 30702002415 | LIBRES SEGURIDAD S.R.L. |
| PUEYRREDON 2418 | `VEP RETENCION` | 30710015607 | COOPERATIVA DE TRABAJO DE SEGURIDAD Y VIGILANCIA DOGO ARGENTINO LTDA |

- **PROVEEDOR**: la palabra fija `VEP RETENCION` — mayúsculas, sin tilde, un espacio —
  como `METROGAS` o `EDESUR` son palabras fijas. El sync la compara con `trim().toUpperCase()`
  y la guarda normalizada, porque `findByProviderName` es igualdad exacta. No es un proveedor
  de `_Proveedores` y el sync no debe buscarlo ahí (hoy avisa "no está marcado como
  SERVICIO" para cualquier PROVEEDOR ausente; para esta palabra el aviso se omite).
- **NRO CLIENTE**: CUIT del consorcio, sólo dígitos. Es lo único que el VEP imprime.
- **DESCRIPCIÓN**: para este tipo, la **razón social exacta** de `_Proveedores` de la
  empresa retenida. El sync (`directorySync.service.ts`) la resuelve a `providerId`. Si no la
  encuentra, la fila se crea igual sin `providerId` y el reporte avisa:
  `"VEP RETENCION de CALLAO 1441: la empresa 'X' no está en _Proveedores"`. Una fila sin
  empresa hace que el VEP entre al edificio pero sin proveedor — la obligación no se cumple.
- Las dos empresas ya existen con CUIT (Libres `30-71144782-9`, Dogo `30-66293417-4`).

Para los demás tipos de `LspService` la columna DESCRIPCIÓN sigue siendo texto libre; el
sync sólo la interpreta como proveedor cuando PROVEEDOR es `VEP RETENCION`.

### 4.3 Gasto fijo

En "Agregar gastos fijos" la fila aparece en **SERVICIOS (LSP)** de ese edificio, con
etiqueta `VEP RETENCION · LIBRES SEGURIDAD S.R.L.` (`availableTargets.ts` resuelve el nombre
por `providerId` contra la lista de proveedores del payload; sin `providerId`, muestra
`VEP RETENCION (30702002415)` como hoy). Es un gasto fijo **distinto** del que la misma
empresa tiene como proveedor común (su factura mensual): el unique de `FixedExpense` separa
`providerId` de `lspServiceId`, así que conviven.

Contraste final en el modal:

| | ARCA EMPLEADO | VEP RETENCIÓN |
|---|---|---|
| Sección | PROVEEDORES | SERVICIOS (LSP), sólo en su edificio |
| Se tilda en | edificios con empleado | edificios que retienen a una empresa |
| Cumple con | VEP de DJ, ART o F931 | VEP con códigos 217/767/353 |

---

## 5. Métricas y etiquetas

- `reasonCategory` nuevos: `vep_mixto` y `vep_desconocido` (Revisión),
  `vep_retencion_not_registered` (Sin Asignar).
- `UNASSIGNED_TAG_BY_CATEGORY["vep_retencion_not_registered"] = "VEP RETENCION SIN EMPRESA REGISTRADA"`.
- Etiqueta de Revisión: `[VEP MIXTO]`.
- Consulta en `scripts/metrics-cuota.sql`: VEP por tipo (`lspProvider` no se persiste; se
  cuenta por `reasonCategory` y por `Invoice.lspServiceId` apuntando a filas `VEP RETENCION`).

---

## 6. Tests

`src/lib/vepExtraction.test.ts` (nuevo):
- `classifyVep`: SICOSS puro → `EMPLEADO`; 217/767/353 → `RETENCION`; consolidado sólo 312
  → `EMPLEADO`; SICOSS + 353 → `MIXTO`; códigos fuera de ambas listas → `DESCONOCIDO`; sin
  paréntesis legibles → `SIN_CODIGOS`.
- `extractVepContribuyenteCuit`: devuelve el rotulado `CUIT:` y no el de "Generado por el
  Usuario"; null si no está.

`src/lib/extraction.test.ts`: `identifyLSPProvider` devuelve `VEP_RETENCION` / `VEP_MIXTO` /
`VEP` según el texto (fixtures tomados de Callao p7, Callao p26, Pueyrredón p12 y p34).

`src/jobs/processPendingDocuments.job.test.ts` (caracterización, 1 por camino):
- `VEP_RETENCION` con fila → boleta al consorcio de la fila, proveedor = `providerRef`,
  `lspServiceId` seteado, `providerId` **no** es la administradora aunque su CUIT esté en
  `allTaxIds`.
- `VEP_RETENCION` sin fila → Sin Asignar, `vep_retencion_not_registered`, etiqueta nueva.
- `VEP_RETENCION` sin CUIT rotulado → no entra al fast-path.
- `VEP_MIXTO` → Revisión, `[VEP MIXTO]`, `aiRequests = 0`; `DESCONOCIDO` → `[VEP SIN CLASIFICAR]`.
- `VEP_RETENCION` con `clientNumber` alucinado por el modelo → se pisa con el CUIT rotulado.
- `VEP` (encargado) → sin cambios: sigue a `ARCA`/`ARCA EMPLEADO` por nombre.

`src/services/directorySync.service` (o `directorySyncPlan.test.ts` si la resolución se
mueve al plan puro): fila `VEP RETENCION` con DESCRIPCIÓN válida → `providerId` de la
empresa; con DESCRIPCIÓN desconocida → fila sin `providerId` + warning; fila `METROGAS` con
DESCRIPCIÓN libre → no se toca.

`src/app/admin/obligaciones/lib/availableTargets.test.ts`: fila `VEP RETENCION` con
`providerId` → etiqueta con la razón social; sin `providerId` → etiqueta con el número.

---

## 7. Fuera de alcance

- Más de una empresa retenida por consorcio (mismo régimen): el VEP no lo distingue.
- Leer el F.2004 (certificado de retención) para vincular VEP ↔ factura retenida.
- Migración de schema: no hay.
- UI de edición de proveedores (el renombre de ARCA se hace por SQL una sola vez).
