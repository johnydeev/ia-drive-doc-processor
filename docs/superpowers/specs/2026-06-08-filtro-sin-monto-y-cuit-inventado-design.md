# Spec — Filtro "sin monto" + verificación de CUIT inventado

Fecha: 2026-06-08
Estado: Aprobado (diseño). Pendiente de plan de implementación.

---

## 1. Objetivo

Frenar dos clases de errores en el pipeline, detectadas con documentos reales:

1. **Documentos que no son facturas** (certificados de revisión, informes de
   mantenimiento, obleas, avisos de ALIAS) entran al buzón de Pendientes y la IA
   los fuerza al esquema de factura.
2. **CUIT inventado:** en uno de esos casos la IA alucinó proveedor `TELECOM
   ARGENTINA S.A.` + un CUIT que **no está en el documento**, y como ese CUIT
   coincidió con el Telecom real de la DB, se matcheó y registró mal.

Caso testigo (ambos de `TEKNICA ELEVACIÓN S.A`, mantenimiento de ascensores, sin
monto): un "Certificado de revisión Nº 2606684" (la IA puso TELECOM) y un
"Reporte de Mantenimiento Nº 2606684" (la IA puso TK ELEVADORES). Ninguno es
factura, ninguno tiene importe.

---

## 2. Decisiones de diseño (cerradas)

| Tema | Decisión |
|---|---|
| Disparador #1 | Solo `amount == null` (ausente / no extraíble). **`amount === 0` es válido** y se registra. |
| `amount === 0` | Caso real: boletas LSP de $0 (la empresa dedujo beneficios, no atribuyó pago) → hay que rendirlas. Se procesan normal. |
| Tag #1 | Se agrega ` - SIN MONTO` al **nombre original** del archivo (no se le pone el nombre de factura, que puede estar mal). |
| Destino #1 | Carpeta **Revisión** (`driveFoldersJson.failed`). No se escribe en Sheets ni se guarda Invoice. |
| Alcance CUIT (#2) | Verificación de CUIT-en-texto **solo para documentos NO-LSP** (`lspProvider === null`). |
| LSP intacto | En LSP el CUIT viene **hardcodeado en el prompt** (no del texto) y el proveedor se resuelve por `clientNumber → LspService`. Verificar CUIT-en-texto los rompería → se excluyen. |
| Fuera de alcance | Flag `isInvoice`/tipo de documento y endurecer prompts → otra ronda. |

---

## 3. Feature 1 — Gate "sin monto" → Revisión

### Regla
Tras la extracción IA, si **`extracted.amount == null`** (nullish: null o
undefined; **NO** incluye `0`):
1. **Renombrar** el archivo en Drive: nombre actual (`file.name`, el del PDF en
   Pendientes) + ` - SIN MONTO` (antes de la extensión). Ej:
   `Certificado de revisión....pdf` → `Certificado de revisión... - SIN MONTO.pdf`.
2. **Mover** a Revisión (`driveFoldersJson.failed`), desde `finalSourceFolderId`.
3. **No** escribir en Sheets. **No** guardar Invoice.
4. Métrica: `result = "no_amount"`, `reason = "no_amount"`. Log claro.
5. `return` (corta el procesamiento de esa boleta).

### Por qué `0` es válido
Una boleta LSP puede venir con importe `0,00` legítimo (beneficio deducido / sin
pago atribuido). Debe registrarse para rendir cuentas. Por eso el gate dispara
solo con `null`, nunca con `0`. Los documentos administrativos (certificados,
obleas) devuelven `amount = null` (la IA no encuentra importe), así que caen acá.

### Ubicación en el pipeline
En `processDriveFile`, **después** de tener `extracted` final y el snapshot de
métricas, **antes** del dedup por clave de negocio y del `resolveAssignment`
(no hace falta matchear consorcio/proveedor para un documento que se rechaza).

---

## 4. Feature 2 — Verificación de CUIT-en-texto (solo NO-LSP)

### Regla
Solo si **`lspProvider === null`** (documento no-LSP) y hay **texto extraído**
del documento (`docText` no vacío — no aplica a imágenes por Vision):
- Para cada CUIT extraído (`extracted.providerTaxId` y cada uno de
  `extracted.allTaxIds`): normalizar a dígitos y verificar que esa secuencia de
  dígitos **aparezca** en el texto del documento (también normalizado a dígitos).
- Si **no aparece** → se **descarta** ese CUIT (era inventado). Log:
  `⚠️ CUIT inventado descartado (no está en el texto): <cuit>`.
- `providerTaxId` descartado → `null`. `allTaxIds` → se filtran los ausentes.

### Efecto
Sin CUIT válido, `resolveAssignment` no puede matchear proveedor por CUIT y cae
al **matching por nombre** (fallback existente). Si el nombre tampoco matchea →
Sin Asignar. Mata el caso TELECOM (CUIT alucinado que matcheaba un proveedor real
de la DB) sin tocar el camino LSP.

### Por qué excluir LSP
- En LSP el CUIT lo provee el **prompt** (hardcodeado por empresa), no el
  documento → "no está en el texto" sería un falso positivo.
- EDESUR/AySA/etc. resuelven el proveedor por `clientNumber → LspService →
  proveedor`, y el CUIT canónico final sale de la **DB**, no del papel. Aunque el
  CUIT venga acostado/vertical o ausente, el proveedor se resuelve igual.

### Ubicación
Tras el gate #1 (si hay monto), **antes** de `resolveAssignment` (que consume los
CUITs para matchear).

---

## 5. Helpers puros (nuevos, testeables)

Nuevo módulo `src/lib/documentValidation.ts`:

```ts
/** true si NO hay monto extraíble (nullish). 0 es un monto válido → false. */
export function isMissingAmount(amount: number | null | undefined): boolean {
  return amount === null || amount === undefined;
}

/** ¿Los dígitos del CUIT aparecen en el texto del documento? (tolera guiones/espacios) */
export function cuitAppearsInText(cuit: string | null | undefined, text: string): boolean {
  const c = (cuit ?? "").replace(/\D/g, "");
  if (c.length < 10) return false;          // CUIT real = 11 dígitos
  const t = (text ?? "").replace(/\D/g, "");
  return t.includes(c);
}

/** Agrega " - SIN MONTO" antes de la extensión del nombre actual. */
export function appendNoAmountTag(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return `${fileName} - SIN MONTO`;
  return `${fileName.slice(0, dot)} - SIN MONTO${fileName.slice(dot)}`;
}
```

> Requiere liftear el texto del documento a una variable de scope de función
> (`docText`) en `processDriveFile`, seteada en las ramas de extracción PDF
> (vacío para imágenes), para poder pasarla a `cuitAppearsInText`.

---

## 6. Integración (orden tras la extracción)

```
extracción IA → snapshot de métricas →
  1. ¿isMissingAmount(extracted.amount)?  → SÍ: renombrar (+ SIN MONTO) + mover a
     Revisión + metrics(result=no_amount) + return.
  2. (hay monto) ¿lspProvider === null y hay docText? → sanear CUITs
     (descartar los que no estén en el texto).
  3. dedup por clave de negocio → resolveAssignment → ... (flujo normal).
```

---

## 7. Edge cases

- **Imágenes (JPG/PNG, Vision):** sin `docText` → #2 no aplica. #1 sí (si
  `amount == null` → Revisión).
- **`amount === 0`:** válido, se procesa y registra (LSP $0). NO va a Revisión.
- **Factura no-LSP legítima con CUIT mal-OCReado/acostado:** se descarta el CUIT →
  intenta por nombre; si falla → Sin Asignar (falla segura, no dato mal
  atribuido). Es raro en facturas normales (lo acostado es típico de LSP).
- **Duplicado sin monto:** el gate #1 corta antes del dedup → va a Revisión con el
  tag (no se evalúa duplicado). Aceptable.

---

## 8. Plan de verificación

- `npx tsc --noEmit -p tsconfig.json` limpio.
- Script `tsx` para los 3 helpers puros:
  - `isMissingAmount`: `null`→true, `undefined`→true, `0`→**false**, `118000`→false.
  - `cuitAppearsInText`: CUIT presente (con/sin guiones)→true; CUIT ausente→false;
    CUIT < 10 dígitos→false.
  - `appendNoAmountTag`: `"x.pdf"`→`"x - SIN MONTO.pdf"`; sin extensión → sufijo al final.
- Funcional (prod, tras deploy): reprocesar los 2 PDFs de ascensores → ambos a
  Revisión renombrados `... - SIN MONTO.pdf`, sin fila en Sheets ni Invoice. Una
  factura no-LSP con CUIT inventado → CUIT descartado, no se atribuye proveedor.
  Una boleta LSP de $0 → se registra normal (no va a Revisión).

---

## 9. Fuera de alcance (futuro)

- Flag `isInvoice` / `documentType` en la extracción IA + ruteo de no-facturas
  que sí traigan algún número.
- Endurecer los prompts contra inventar proveedor/CUIT ("no inferir, no calcular").
- Clasificación de tipos de documento administrativo (oblea, alias, certificado).
