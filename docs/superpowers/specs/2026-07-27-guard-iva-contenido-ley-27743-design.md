# Spec — Guard de IVA contenido (Ley 27.743) tomado como monto total

**Fecha:** 2026-07-27
**Tipo:** Bugfix de extracción (error crítico: monto incorrecto persistido en DB + Sheets).
**Origen:** boleta real `0003-00161074` (RANKO S.R.L. → BARTOLOME MITRE 1225, período 07/2026),
registrada el 23/07/2026 con **$62.601,88** cuando el total de la factura es **$360.706,09**.

---

## 1. Diagnóstico (verificado, no inferido)

El monto guardado es **exactamente el IVA contenido** de la factura:
`360.706,09 × 21/121 = 62.601,88`.

Reconstrucción del layout real de la página 1 (coordenadas vía pdfjs, no orden del texto):

```
y=460 | SERVICIO DE MANTENIMIENTO ANUAL DE LOS EXTINTORES   360706.09   360706.09
y= 76 | Régimen de Transparencia Fiscal al Consumidor (Ley 27.743)
y= 60 | IVA Contenido: $[x=112]   62601.88[x=184]      ← rótulo y valor JUNTOS en el PDF
y= 48 |                            $[x=477]  360706.09[x=519]   ← el TOTAL, sin rótulo textual
y= 44 | Otros Impuestos Nacionales Indirectos: $   0.00
```

**Dos causas que se combinan:**

1. **El importe total no tiene rótulo de texto.** La palabra "TOTAL" pertenece al formulario
   preimpreso (imagen), no al texto. En el texto extraído `360706.09` es un número suelto sin
   nada que lo identifique.
2. **`pdf-parse` linealiza el PDF en un orden que huerfaniza los valores.** `IVA Contenido: $` y
   `62601.88` están en la misma línea física del PDF, pero en el texto quedan a **16 líneas** de
   distancia (rótulo en la línea 5, vacío; número en la 21).

La IA recibe rótulos vacíos y números sueltos, sin forma de atarlos, y elige mal. El prompt
tampoco la ayuda: su única regla de monto es *"Importe Total / Total a pagar, nunca un subtotal"*
— y el IVA contenido **no es un subtotal**, así que la regla no lo excluye.

**Descartado explícitamente:** no es la truncación a 80 líneas (el documento entero son 26 líneas
no vacías); no es `reflowAfipTotals` (exige el rótulo `Importe Total`, ausente en este formulario
→ su no-op es correcto); no es el matching de proveedor/consorcio ni el OCR.

## 2. Por qué importa más allá de esta boleta

El bloque **"Régimen de Transparencia Fiscal al Consumidor (Ley 27.743)"** es obligatorio en toda
factura a consumidor final desde 2025, y los consorcios reciben facturas como consumidor final de
forma habitual. La trampa —una cifra que no es un subtotal, está dentro del total, y queda huérfana
de su rótulo— va a repetirse. No es un caso aislado.

## 3. Decisiones de diseño

| # | Decisión | Alternativas descartadas |
|---|----------|--------------------------|
| 1 | **Guard determinista que auto-corrige**, con 4 condiciones simultáneas (§4). La identidad aritmética es prácticamente una prueba, no una heurística. | **Derivar a Revisión con tag "MONTO DUDOSO"**: riesgo cero de escribir un número inventado, pero suma trabajo manual sobre un volumen que va a crecer. **Solo endurecer el prompt**: queda dependiendo de que el modelo obedezca, sin red determinista si un proveedor de la cadena falla o cambia el layout. |
| 2 | **El guard vive en `src/lib/vatContainedAmountGuard.ts`** (función pura + test tier 0), invocado desde `refineExtractionWithRawText`. | Ponerlo en el pipeline (`aiExtractStep`): perdería el flujo cacheado y obligaría a duplicarlo. Ponerlo en cada extractor: son 5, se desincronizan. `refineExtractionWithRawText` ya es el punto único por el que pasan los 5 extractores + la rama cacheada. |
| 3 | **No aplica a boletas LSP** (respeta el early-return `isUtilityBill`). | Aplicarlo a LSP arriesga romper la regla del **primer vencimiento**: en esas boletas el monto correcto NO es el máximo (el segundo vencimiento con recargo es mayor), justo la forma que el guard usa como señal. Los prompts LSP son por empresa y extraen de un "Total a pagar" bien rotulado. |
| 4 | **Tasas contempladas: 21% y 10,5%.** | 27% excluido a propósito: aplica a servicios a responsables inscriptos, no al régimen de transparencia a consumidor final; cada tasa extra amplía la superficie de falso positivo. Facturas con IVA mixto no disparan el guard (no-op seguro). |
| 5 | **Endurecer también el prompt** de facturas normales, como primera línea de defensa. | Solo el guard: el guard cubre la identidad exacta; el prompt cubre los casos de IVA mixto o layout distinto donde la aritmética no cierra. Son complementarios. |
| 6 | **Auditoría de las 883 boletas ya procesadas: documentada, no implementada** (decisión del owner: "documentala para otra sesión"). | Ver §7. |

## 4. Las 4 condiciones del guard (todas deben cumplirse)

El guard corrige `amount` → `max` solo si:

1. **Marcador presente**: el texto contiene `Ley 27.743`, `IVA Contenido` u `Otros Impuestos
   Nacionales Indirectos`.
2. **Identidad aritmética exacta**: `|amount − max × r/(1+r)| ≤ 0,05` para `r ∈ {0,21; 0,105}`.
3. **El candidato es la cifra máxima del documento** (y por definición aparece en él).
4. **El monto de la IA NO es la cifra máxima** del documento.

Si alguna falla → no-op, se respeta lo que extrajo la IA. La función es **pura e idempotente**.

**Qué pasa si el guard no alcanza** (ej. IVA mixto, o el total no es el máximo por un "saldo
anterior"): el monto queda como lo extrajo la IA. El guard es una red de seguridad, no una
garantía — por eso el prompt endurecido (decisión 5) es parte del fix, no un extra.

## 5. Observabilidad

Cuando el guard corrige, emite `console.warn` con prefijo `[vat-guard]` incluyendo monto original,
monto corregido y tasa detectada. Consistente con `[pdf-extractor]`; visible en los logs del worker.
**No** se toca el campo `observation` de la boleta (contaminaría la columna de Sheets).

## 6. Remediación de la boleta ya cargada

No existe endpoint `PATCH` de boleta — el monto no es editable desde la UI (solo `DELETE`). El
camino correcto, sin código nuevo:

1. Deployar el fix (commit a master → deploy automático).
2. Borrar la boleta `0003-00161074` desde la UI (pestaña Boletas o "Boletas entrantes"). El borrado
   ya mueve el PDF de vuelta a `pending` y elimina la fila de Sheets.
3. El scheduler la reprocesa y esta vez el guard corrige el monto.

## 7. Pendiente documentado — auditoría de boletas históricas (otra sesión)

El texto del PDF **no se persiste** en la DB, así que no se puede detectar retroactivamente con una
query. Sí se puede con un **script de solo lectura** que, para cada boleta: descargue el PDF desde
Drive (`sourceFileUrl` está guardado), extraiga el texto con `PdfTextExtractorService`, aplique
`correctVatContainedAmount` sobre el `amount` almacenado y reporte los casos donde el guard
dispararía. **No escribe en DB ni en Sheets**: emite una tabla de sospechosos para revisión manual.

Costo estimado: ~883 descargas de Drive, sin tokens de IA. Conviene correrlo fuera del horario del
scheduler. Spec propio pendiente.

## 8. Verificación

`npm run typecheck` + `npm run lint` + `npx vitest run` + `npm run build:jobs` + `npm run build`.
Tests nuevos (tier 0, entorno node): el caso real RANKO con su texto literal, los cuatro no-op de
cada condición, IVA 10,5%, formato es-AR, idempotencia, y que `refineExtractionWithRawText` no lo
aplique a boletas LSP.

## 9. Documentación (regla del proyecto)

`docs/progreso.md` (fix + pendiente de auditoría + remediación de la boleta), `docs/decisiones.md`
(la decisión de auto-corregir con condiciones estrictas y por qué no se derivó a Revisión),
`CHANGELOG.md`.
