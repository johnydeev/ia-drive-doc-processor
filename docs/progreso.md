# Progreso del proyecto — drive-doc-processor

Actualizado al 21/03/2026.

---

## Estado general

El sistema core está funcionando en producción. Pipeline de PDFs, extracción IA, matching y envío a Sheets completo. Se acaba de refactorizar el sistema de extracción IA para LSPs con prompts por empresa y mejoras en normalización de direcciones.

---

## Completado ✅

- Pipeline de procesamiento de PDFs (download → dedup → extracción → match → Sheets → mover)
- Extracción IA con Gemini + fallback OpenAI
- **Prompts LSP por empresa** — `identifyLSPProvider()` como router con prompts específicos para Edesur, Edenor, AySA, Metrogas, Naturgy, Camuzzi, Litoral Gas (21/03/2026)
- **Normalización de direcciones LSP** — limpieza de ceros a la izquierda, sufijos numéricos, código postal, piso/depto (21/03/2026)
- **CUIT hardcodeado por empresa LSP** — elimina confusión entre CUIT del proveedor y del consorcio (21/03/2026)
- **Reglas dueDate específicas** — CESP, CAE y otras fechas inválidas documentadas por empresa (21/03/2026)
- Matching de consorcios (exacto + fuzzy + alias) con expansión de abreviaturas
- Matching de proveedores (CUIT + nombre + parcial)
- Deduplicación por hash SHA256 y business key
- Sistema multi-tenant con roles ADMIN / CLIENT / VIEWER
- Autenticación con JWT + cookie httpOnly
- CRUD de consorcios, proveedores y períodos
- Importación masiva desde Excel (edificios + proveedores)
- Recibo de pago: subida a Drive + guardado en Invoice
- Scheduler + Worker como procesos separados
- Script `run-local.ps1` para levantar los 3 procesos
- Sincronización directorio ALTA (Sheets → DB) con 4 hojas
- Panel admin con métricas, alta de clientes, edición de configuración
- Campo `aliases` en Consortium (migración aplicada)
- Tablas Rubro y Coeficiente a nivel cliente (migración aplicada)
- Regla de documentación obligatoria en `docs/` establecida (21/03/2026)

---

## En progreso 🔄

- **Validación en producción de prompts LSP refactorizados**
  - Archivos desplegados: `src/lib/extraction.ts`, `src/lib/consortiumNormalizer.ts`
  - Falta: probar con PDFs reales de Edesur, AySA, Metrogas en el worker
  - Si persisten errores: ajustar prompts con ejemplos del texto real extraído

---

## Pendiente ❌

### Alta prioridad
- [ ] Probar extracción LSP refactorizada con PDFs reales en producción
- [ ] UI de edición de aliases de consorcio desde el panel (hoy solo via SQL en Supabase)

### Media prioridad
- [ ] UI de gestión de carpetas Drive por cliente desde el panel admin
- [ ] Agregar URL de recibo a columna de Google Sheets
- [ ] Resincronización automática con Sheets cuando Google falla

### Baja prioridad
- [ ] UI para asignar Rubro y Coeficiente a invoices individuales desde el panel (Stage 2)

---

## Próximos pasos sugeridos

1. Probar los prompts LSP refactorizados con PDFs reales
2. Si hay errores, capturar el texto extraído del PDF y ajustar el prompt correspondiente
3. Construir UI de edición de aliases de consorcio
4. Construir UI de gestión de carpetas Drive

---

## Problemas conocidos

- En Windows, `npx prisma generate` puede fallar si los 3 procesos están corriendo (el `.dll` queda bloqueado). Parar todo antes de migrar.
- PowerShell no soporta `&&`. Siempre correr comandos por separado.
- Números de calle distintos entre factura y DB (ej: Edesur 708 vs DB 706) no se resuelven automáticamente → registrar alias manualmente.
