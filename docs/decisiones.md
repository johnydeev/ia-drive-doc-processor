# Decisiones técnicas — drive-doc-processor

Registro de decisiones tomadas ante problemas reales encontrados en producción.

---

## 2026-03-21 — Prompts LSP por empresa con CUIT hardcodeado

### Problema
La extracción IA de facturas de servicios públicos (LSP) tenía 3 errores recurrentes:
1. **CUIT confundido**: en LSPs el CUIT del consorcio (cliente/receptor) aparece prominente en el documento, y la IA lo tomaba como providerTaxId. En AySA el CUIT del cliente aparece al final con "IVA RESPONSABLE INSCRIPTO - CUIT No. XX-XXXXXXXX-X".
2. **Fecha CESP/CAE como dueDate**: en facturas de AySA aparece "C.E.S.P: XXXXX | Fecha Vto: DD/MM" donde "Fecha Vto" es del código electrónico de servicio público, no de pago. La IA lo tomaba como fecha de vencimiento de pago.
3. **Consorcio no matchea**: las LSPs formatean direcciones con ceros a la izquierda (00706), sufijos numéricos extras (706 018), código postal (C1414AWF) y localidad (CAPITAL FEDERAL). El normalizer no los limpiaba.

### Decisión
Refactorizar `extraction.ts` con un router `identifyLSPProvider()` que detecta la empresa y despacha a un prompt específico:
- `buildEdesurPrompt()` — CUIT 30-71079642-7 hardcodeado, regla de primer vencimiento
- `buildAysaPrompt()` — CUIT 30-70956507-5, advertencia explícita de trampa CESP y CUIT del cliente al final
- `buildEdenorPrompt()` — CUIT 30-65651651-4
- `buildGasPrompt()` — Metrogas, Naturgy, Camuzzi, Litoral Gas con CUITs respectivos
- `buildGenericUtilityBillPrompt()` — fallback para LSPs no identificadas

Cada prompt incluye:
- CUIT de la empresa hardcodeado → elimina confusión con CUIT del cliente
- Reglas de dueDate específicas → señala explícitamente qué campos son inválidos (CESP, CAE, emisión)
- Reglas de dirección unificadas en `CONSORTIUM_ADDRESS_RULES`

En `consortiumNormalizer.ts` se agregaron 4 funciones de limpieza: `stripLeadingZeros`, `stripTrailingNumericSuffix`, `stripPostalAndLocality`, `stripFloorUnit`.

### Alternativas descartadas
- **Prompt único mega-detallado**: se intentó antes con un solo `buildUtilityBillPrompt()` con muchas reglas. No funcionaba porque las instrucciones genéricas no eran lo suficientemente específicas para cada formato de empresa.
- **Post-procesamiento del CUIT**: validar el CUIT extraído contra una lista conocida después de la extracción. Descartado porque no resuelve el problema de raíz y agrega complejidad.

### Impacto
- Archivos modificados: `src/lib/extraction.ts`, `src/lib/consortiumNormalizer.ts`
- Interfaces exportadas: sin cambios (backward compatible)
- Mejora esperada: eliminación de los 3 errores reportados en extracción de LSPs

---

## 2026-03-20 — Private key encriptada pasada directamente a GoogleSheetsService

### Problema
Al implementar la sincronización del archivo ALTA, se pasaba `client.googleConfigJson.privateKey` directamente al constructor de `GoogleSheetsService`. La private key estaba encriptada en DB → error `error:1E08010C:DECODER routines::unsupported`.

### Decisión
Usar siempre `resolveGoogleConfig(client)` que desencripta la private key antes de construir cualquier servicio de Google. Documentado como bug crítico resuelto en CLAUDE.md.

### Impacto
- Archivo modificado: `src/app/api/client/sync-directory/route.ts`
- Regla: nunca acceder a `client.googleConfigJson.privateKey` directamente

---

## 2026-03-21 — Regla obligatoria de documentación en docs/

### Problema
El progreso del proyecto, las decisiones técnicas y el estado de las features no se documentaban consistentemente. Al retomar el contexto (ya sea por otro desarrollador o por el mismo en otra sesión), se perdía tiempo redescubriendo qué se hizo, por qué, y qué queda pendiente.

### Decisión
Establecer como regla obligatoria que todo cambio significativo debe actualizar 3 archivos:
- `docs/progreso.md` — estado de cada feature
- `docs/decisiones.md` — registro de decisiones ante problemas
- `CHANGELOG.md` — log cronológico

La regla se documenta en CLAUDE.md como sección prioritaria y aplica a todo contexto de desarrollo.

### Impacto
- Archivos modificados: `CLAUDE.md`, `docs/progreso.md`, `docs/decisiones.md`
- Aplica a todas las sesiones futuras de desarrollo
