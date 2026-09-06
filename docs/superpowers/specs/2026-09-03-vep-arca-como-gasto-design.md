# El VEP de ARCA pasa a registrarse como gasto

**Fecha:** 2026-09-03
**Estado:** corregido el 2026-09-03 tras revisarlo contra el código (ver la enmienda en §3.2), sin implementar
**Origen:** el owner quiere registrar los VEP (Volante Electrónico de Pago) que cada consorcio paga a
ARCA — las cargas sociales de su encargado. Hasta ayer el VEP era un **no-boleta**: el triage lo
mandaba a Sin Asignar sin gastar tokens. Esto lo revierte, igual que pasó con el LSD.

---

## 1. Lo que dicen los papeles

Cinco VEP reales: cuatro PDF digitales y una foto de uno de ALMIRANTE BROWN 706.

**El formato es idéntico en los cinco.** Campos, con sus rótulos exactos:

| Campo | Rótulo | Ejemplo (ALMIRANTE BROWN) |
|---|---|---|
| Número | `Nro. VEP:` | `1570130517` |
| Emisor | `Organismo Recaudador:` | `ARCA` |
| Tipo | `Tipo de Pago:` | `Empleadores SICOSS - Saldo DJ` |
| **Contribuyente** | `CUIT:` | `30-52063978-7` |
| Período de la obligación | `Período:` | `2025-12` |
| Vencimiento | `Día de Expiración:` | `2026-02-08` |
| Monto | `Importe total a pagar` | `$1.123.728,00` |

**El CUIT del encabezado es el del contribuyente**, y en un VEP de consorcio **es el del edificio**:
`30-52063978-7` es ALMIRANTE BROWN 706, verificado contra la base.

### El segundo CUIT, que es una trampa

El papel trae **dos** números que pasan el checksum de CUIT:

```
CUIT: 30-52063978-7                    ← el consorcio (contribuyente)
Generado por el Usuario: 27324998573   ← MORINIGO RAMONA NATALIA
```

El segundo es **la administradora legal**, que además es **un proveedor real del consorcio**: cobra
honorarios y ya tiene **16 boletas** cargadas a su nombre. Y firma **todos** los VEP de **todos** los
edificios, así que su CUIT viaja en cada uno.

Si el VEP se procesara como una factura común —donde el proveedor se matchea por CUIT— **todos los
VEP quedarían imputados a la administradora como proveedor**. El error sería casí invisible: una
boleta más a su nombre, con monto plausible, mezclada entre sus honorarios reales. Es exactamente el
bug del 2026-07-02 (ASCENSORES POTENZA) que motivó pasar el matching a CUIT puro.

> Hoy tiene **0 gastos fijos activos**, así que el peor escenario —que un VEP marque como cumplida la
> obligación de honorarios y tape un mes sin facturar— todavía no puede darse. **Si algún día se le
> carga un gasto fijo de honorarios, ese riesgo se activa.**

### El router no lo reconoce hoy

Medido sobre los cinco papeles:

| | Resultado actual |
|---|---|
| Triage capa 0 | lo detecta como `VEP` → **Sin Asignar, sin llegar a la IA** |
| Router de prompts | `null` → iría al **prompt de facturas comunes** |
| ¿Dice `931`? | **No** — la regla de ARCA exige ese número y el VEP no lo trae |

`buildArcaPrompt` existe y `ARCA` ya está en `usesConsortiumCuit`, pero el router nunca llega: busca
el `931` de la **declaración jurada**, y el VEP es el **cupón de pago** de esa misma declaración.

## 2. Decisiones tomadas

| Tema | Decisión |
|---|---|
| Detección | `"VEP"` en `LSPProvider`, por el encabezado, **antes** de la regla de ARCA |
| Matching de consorcio | Por **CUIT solamente**: `"VEP"` entra en `usesConsortiumCuit` y además se le pasa `cuitOnly` (§3.2 bis) |
| Matching de proveedor | Por **nombre solamente**: al VEP se le corta `allTaxIds` (§3.2). `usesConsortiumCuit` **no alcanza** |
| Prompt | Propio (`buildVepPrompt`), no se reusa el de ARCA |
| Proveedor | `ARCA`, que ya existe en el directorio sin CUIT |
| Período | El **activo del consorcio**, como toda otra boleta. El del papel va al detalle |
| Gasto fijo | Uno por edificio con empleados, con proveedor ARCA — lo carga el owner a mano |
| Triage | El VEP **sale de la capa 0**, que queda vacía |

## 3. Diseño

### 3.1 Detección

`isVep(upper)` sobre el encabezado, con los marcadores **ya calibrados ayer** para el triage
(`VOLANTE ELECTRONICO DE PAGO`, `NRO. VEP:`) — se mudan de módulo, no se reescriben. Va **primero**
en `identifyLSPProvider`, antes de la regla del `931`, porque un VEP de SICOSS es el pago de un F931
y sin ese orden competirían.

### 3.2 `usesConsortiumCuit` no alcanza — enmienda del 2026-09-03

**La primera versión de este spec decía que meter `"VEP"` en `usesConsortiumCuit` dejaba
"inerte" el CUIT de la administradora. Es falso, y al revés: lo inyecta.** Se detectó al
revisar el spec contra el código, antes de implementar. Queda escrito porque el
razonamiento equivocado es fácil de repetir.

`usesConsortiumCuit` hace **una** cosa, no dos: habilita el match de proveedor **por
nombre**. No desactiva el match por CUIT, que corre siempre **antes**
(`matchProvider`, `src/lib/assignmentMatching.ts`):

```ts
// Intento 0: CUIT match usando allTaxIds, excluyendo CUIT del consorcio
if (allTaxIds.length > 0) { ... }
// Niveles por NOMBRE: SOLO para sindicales/ARCA
if (allowNameMatch) { ... }
```

Y la regla del prompt tampoco protege, porque el pipeline vuelve a meter ese CUIT
**después** de la IA. `cuitSanitizeStep`, para todo el grupo `usesConsortiumCuit`:

```ts
if ((lspProvider === null || isSindical) && docText) {
  const textCuits = extractCuitsFromText(docText);   // regex + checksum sobre TODO el papel
  extracted.allTaxIds = [...merged];
```

El comentario de ese bloque afirma que sumar todos los CUITs del papel "es seguro"
porque el matching excluye el del consorcio. **Vale para los sindicales y no para el
VEP**, y esa es toda la diferencia: en una boleta sindical el otro CUIT es el del
recaudador, que **es** el proveedor correcto; en un VEP el otro CUIT es el de la
administradora, que es un proveedor real y **distinto**. Misma línea de código,
resultado opuesto.

Sin el arreglo de abajo, los cinco VEP se imputarían a MORINIGO NATALIA: exactamente el
bug que este spec dice prevenir.

#### El arreglo: cortar el CUIT solo para el proveedor

En `resolveAssignment` (`processPendingDocuments.job.ts`), el VEP no ofrece **ningun**
CUIT al matching de proveedor:

```ts
// VEP: "Generado por el Usuario" es la administradora, proveedor real del consorcio.
// Cualquier match por CUIT le imputa el gasto. El proveedor de un VEP es ARCA, siempre,
// y se resuelve por nombre.
const isVep = lspProvider === "VEP";
const providerMatch = matchProvider(
  allProviders, isVep ? null : rawCuit, rawName,
  isVep ? [] : allTaxIds, consortiumCuitNorm, isSindicalLsp
);
```

`allTaxIds` completo **sigue** yendo a `matchConsortium`: de ahí sale el edificio. Lo que
se corta es solo la vereda del proveedor.

`usesConsortiumCuit("VEP")` sigue siendo necesario —habilita el nombre, y hace que
`cuitSanitizeStep` sume el CUIT del contribuyente aunque la IA lo omita— pero es la
mitad de la solución, no toda.

### 3.2 bis El consorcio, solo por CUIT

`isPlainInvoice = !lspProvider`, así que un VEP conserva hoy los niveles de matching por
nombre (exacto, fuzzy, alias). **Un VEP no imprime la dirección del inmueble**: si la IA
pone cualquier cosa en `consortium`, el fuzzy puede pegarle a un edificio equivocado —
la misma clase de falla que el caso EVA PERON que motivó pasar las facturas comunes a
CUIT puro el 2026-08-26.

```ts
const consortiumCuitOnly = isPlainInvoice || lspProvider === "VEP";
const consortiumMatch = matchConsortium(allConsortiums, rawConsortium, allTaxIds, consortiumCuitOnly);
```

Las etiquetas de Sin Asignar siguen colgadas de `isPlainInvoice`, así que un VEP que no
matchee sale con las etiquetas viejas (`SIN CONSORCIO`). Se deja así a propósito: no es
una factura común y las cuatro etiquetas por CUIT hablan de un emisor que el VEP no
tiene.

### 3.2 ter El `clientNumber` que puede rebotar el VEP entero

El fast-path de `LspService` es **terminal**: si hay `clientNumber` y no se encuentra el
servicio, la boleta sale a Sin Asignar sin apelación.

```ts
if (lspProvider && lspProvider !== "GENERIC_LSP" && normalizedClientNumber) { ... }
```

Ninguno de los cinco miembros de `usesConsortiumCuit` usa `LspService`, pero hoy el
guard que limpia `clientNumber` solo cubre las no-LSP (`if (!ctx.lspProvider && ...)`).
Un `Nro. VEP` colado ahí por el modelo rebotaria el documento entero. El guard se
generaliza al grupo, lo que de paso cubre a ARCA y a los sindicales:

```ts
if ((!ctx.lspProvider || usesConsortiumCuit(ctx.lspProvider)) && extracted.clientNumber) {
```

### 3.3 Prompt propio

`buildVepPrompt` en `src/lib/vepExtraction.ts`. No se reusa `buildArcaPrompt` porque ese está escrito
para la DJ de dos páginas, donde el importe vive en la página 2; un VEP es un cupón simple.

Mapeo, con los rótulos exactos del papel:

| Campo | Sale de |
|---|---|
| `boletaNumber` | `Nro. VEP:` |
| `dueDate` | `Día de Expiración:` |
| `amount` | `Importe total a pagar` |
| `provider` | **la constante `"ARCA"`**, no lo que diga el papel. Es el nombre contra el que matchea el directorio, así que el prompt lo fija en vez de dejarlo a la interpretación del modelo |
| `providerTaxId` | **null** — ARCA está cargado sin CUIT y el matching es por nombre |
| `consortium` / CUIT | el `CUIT:` del encabezado |
| `detail` | `Descripción Reducida` + `Período` (ej. `SIJPDJ12/25 · 2025-12`) |

**Regla explícita en el prompt: ignorar `Generado por el Usuario`.** Es un CUIT y NO es el
contribuyente. **Es la capa blanda, no la defensa**: aunque el modelo la respete,
`cuitSanitizeStep` vuelve a extraer ese CUIT del texto por regex y lo suma a `allTaxIds`
(§3.2). Lo que realmente protege es cortar `allTaxIds` en el matching de proveedor; la
regla del prompt solo evita que llegue también por `providerTaxId`.

### 3.4 Lo que revierte

El VEP sale de `detectDecisiveNotBoleta`, que queda **sin ningún tipo**. La capa 0 se conserva como
mecanismo —vacía— porque el día que aparezca otro formulario a descartar se vuelve a llenar sin
rediseñar nada. Los tests que fijan que un F931 no se confunde con un VEP se conservan, movidos al
router.

### 3.5 Qué pasa con un VEP que no es de un consorcio

Su CUIT no matchea ningún edificio → **Sin Asignar**. Es el comportamiento correcto y no requiere
código: de los cinco modelos, tres son de `G.B GRUPO SERVICIO INTEGRAL S.R.L.` y uno de los aportes
de autónomo de la administradora. **Esos cuatro van a rebotar todos los meses**, y está bien: es
información visible en la carpeta, no un gasto imputado al edificio equivocado.

## 4. Pendientes conocidos (NO entran acá)

**1. VEP de un tercero que paga el consorcio — PRIMARIO.** El owner planteó que un consorcio puede
pagar varios VEP distintos, por ejemplo el de la empresa de seguridad. En ese caso el CUIT del
contribuyente **no es el del edificio**, así que la regla de este spec no alcanza: esos VEP van a ir
a Sin Asignar. Hay que definir cómo se decide a qué consorcio pertenece un VEP de un tercero —
posiblemente por el proveedor (que sí está en el directorio) más algún vínculo con el edificio. **El
owner todavía no tiene la regla clara**, así que no se diseña.

**2. VEP escaneado.** El de ALMIRANTE BROWN es una foto. Sin texto extraíble, el router no se entera
y el documento va a Vision con el prompt genérico, que puede tomar el monto o el CUIT equivocado.
Cubrirlo bien implica decidir el tipo de documento **después** de Vision, que es un cambio de orden
en el pipeline. Los VEP bajados de ARCA son PDF digital y no tienen este problema.

## 5. Riesgos

- **El CUIT de la administradora en todos los VEP** (§1). Mitigado por `usesConsortiumCuit` + la
  regla del prompt. **Si se le carga un gasto fijo de honorarios, revisar que ningún VEP esté
  marcando esa obligación como cumplida.**
- **El período del papel se pierde**: un VEP de `2025-12` que llega hoy se imputa al mes activo.
  Decisión del owner, coherente con el resto del sistema; el período queda en el detalle.
- **La ventana de 200 caracteres tiene poco margen.** En el fixture del F931,
  `Volante Electrónico de Pago` cae en el carácter ~227: 23 de margen. En un papel real la
  DJ es mas larga, pero el detector pasa de **descartar** a **rutear**, así que el costo de
  errarle cambió. Un F931 que cayera adentro de la ventana entraría por el prompt del VEP;
  el monto saldría igual (los dos leen `Importe total a pagar`) pero el número de
  comprobante y el detalle quedarían mal. Hay un test con el papel real que lo fija.
- **Un VEP vencido entra igual.** El de ALMIRANTE BROWN expiró el 2026-02-08. El sistema no valida
  vencimientos, y no es este spec el que debería empezar a hacerlo.

## 6. Tests

| Qué | Dónde |
|---|---|
| Los 5 VEP reales se detectan como `VEP` | `extraction.test.ts` |
| El prompt fija `provider: "ARCA"` y pide ignorar `Generado por el Usuario` | `vepExtraction.test.ts` |
| Un F931 (DJ, con `931`) sigue detectándose como `ARCA`, no como VEP | `extraction.test.ts` |
| Una factura común no se detecta como VEP | `extraction.test.ts` |
| `usesConsortiumCuit("VEP")` es `true` | `extraction.test.ts` |
| El VEP ya **no** es un no-boleta | `documentClassifier.test.ts` |
| El CUIT del consorcio matchea y el de la administradora NO se usa como proveedor, **incluso cuando `allTaxIds` lo trae** | `processPendingDocuments.job.test.ts` |
| Un `consortium` basura devuelto por la IA no arrastra el VEP a otro edificio | `processPendingDocuments.job.test.ts` |
| Un `clientNumber` colado por la IA no rebota el VEP al fast-path de `LspService` | `processPendingDocuments.job.test.ts` |
| Un F931 real (con su VEP en la página 2) sigue siendo `ARCA` | `extraction.test.ts` |
| Un VEP cuyo CUIT no es de ningún consorcio va a Sin Asignar | `processPendingDocuments.job.test.ts` |

## 7. Verificación

`npm run typecheck` + `npx vitest run` + `npm run lint` + `npm run build:jobs`. Sin migración.

Smoke: procesar el VEP de ALMIRANTE BROWN y confirmar que entra imputado a ese edificio, con
proveedor **ARCA** (no la administradora), monto `1.123.728,00` y vencimiento `2026-02-08`.
