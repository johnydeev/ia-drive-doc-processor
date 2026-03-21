# Progreso del proyecto — drive-doc-processor

Actualizado al 20/03/2026.

---

## Estado general

El sistema core está funcionando. El pipeline de procesamiento de PDFs, extracción IA, matching de consorcios/proveedores y envío a Google Sheets está completo y en producción.

---

## Completado ✅

- Pipeline de procesamiento de PDFs (download → dedup → extracción → match → Sheets → mover)
- Extracción IA con Gemini + fallback OpenAI
- Detección automática de LSP (Edesur, AySA, Metrogas, etc.)
- Matching de consorcios (exacto + fuzzy + alias)
- Matching de proveedores (CUIT + nombre + parcial)
- Deduplicación por hash SHA256 y business key
- Sistema multi-tenant con roles ADMIN / CLIENT / VIEWER
- Autenticación con JWT + cookie httpOnly
- CRUD de consorcios, proveedores y períodos
- Importación masiva desde Excel (edificios + proveedores)
- Recibo de pago: subida a Drive + guardado en Invoice
- Scheduler + Worker como procesos separados
- Script `run-local.ps1` para levantar los 3 procesos
- Normalización de nombres de consorcios con abreviaturas

---

## En progreso 🔄

- Campo `aliases` en Consortium
  - Migración lista: `20260319000300_consortium_aliases`
  - Falta aplicar: `npx prisma migrate deploy` → `npx prisma generate`
  - Falta: UI de edición de aliases (hoy solo via SQL en Supabase)

---

## Pendiente ❌

### Alta prioridad
- [ ] Aplicar migración `consortium_aliases`
  ```powershell
  npx prisma migrate deploy
  npx prisma generate
  ```
- [ ] `npm install xlsx` — requerido para que funcione la importación Excel

### Media prioridad
- [ ] UI de edición de aliases de consorcio desde el panel (hoy solo via SQL)
- [ ] UI de gestión de carpetas Drive por cliente desde el panel admin
- [ ] Agregar URL de recibo a columna de Google Sheets

### Baja prioridad
- [ ] Resincronización automática con Sheets cuando Google falla

---

## Próximos pasos sugeridos

1. Aplicar la migración pendiente de aliases
2. Instalar dependencia xlsx
3. Construir UI de edición de aliases
4. Construir UI de gestión de carpetas Drive

---

## Problemas conocidos

- En Windows, `npx prisma generate` puede fallar si los 3 procesos están corriendo (el `.dll` queda bloqueado). Parar todo antes de migrar.
- PowerShell no soporta `&&`. Siempre correr comandos por separado.