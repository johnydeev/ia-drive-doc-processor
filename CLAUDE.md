# CLAUDE.md — drive-doc-processor

Contexto completo del proyecto para Claude Code. Actualizado al 20/03/2026.

---

## Al iniciar sesión
Siempre leer docs/progreso.md antes de empezar para entender el estado actual del proyecto y los próximos pasos.

## Descripción del proyecto

Sistema multi-tenant en **Next.js + TypeScript + Prisma + PostgreSQL (Supabase)** para administración de consorcios de propiedad horizontal en Argentina.

Procesa automáticamente PDFs de facturas/boletas desde Google Drive usando IA (Gemini → OpenAI fallback), extrae datos estructurados, los guarda en la DB y los envía a Google Sheets.

---

## Levantar el entorno de desarrollo

Requiere **3 procesos simultáneos** en terminales separadas:

```powershell
npm run dev       # Servidor Next.js (puerto 3000)
npm run schedule  # Scheduler: escanea Drive y crea jobs
npm run worker    # Worker: procesa la cola de jobs
```

Atajo en Windows:
```powershell
npm run local             # Equivalente: abre las 3 terminales automáticamente
.\scripts\run-local.ps1   # El script subyacente
```

> **IMPORTANTE:** Sin los 3 procesos el sistema no procesa PDFs. Solo `npm run dev` levanta la UI pero no el pipeline.

---

## Comandos frecuentes

```powershell
# Migraciones (siempre en este orden, por separado en PowerShell)
npx prisma migrate deploy
npx prisma generate

# Crear usuario admin inicial
npx tsx scripts/create-admin.ts admin@empresa.com MiPassword123

# Diagnóstico de carpetas Drive de clientes
npx tsx scripts/fix-client-folders.ts              # ver estado
npx tsx scripts/fix-client-folders.ts --clientId=X --pending=Y --scanned=Z  # reparar

# Diagnósticos
npm run diagnose:db       # conexión a base de datos
npm run diagnose:gemini   # extracción con Gemini
npm run diagnose -- <fileId>  # Drive: acceso a archivo específico
```

> **PowerShell:** El operador `&&` no funciona. Siempre correr los comandos por separado.

---

## Arquitectura del sistema

### Tres procesos

| Proceso | Comando | Responsabilidad |
|---------|---------|-----------------|
| Web/API | `npm run dev` | UI + endpoints REST + autenticación |
| Scheduler | `npm run schedule` | Escanea Drive → crea ProcessingJob |
| Worker | `npm run worker` | Procesa cola → extrae → guarda → Sheets |

### Estructura de directorios relevante

```
src/
├── app/
│   ├── api/
│   │   ├── auth/              # login / logout / me
│   │   ├── admin/
│   │   │   ├── clients/       # CRUD clientes (admin)
│   │   │   │   └── [id]/      # GET + PATCH edición de cliente
│   │   │   ├── audit/         # logs de auditoría
│   │   │   └── scheduler/     # control scheduler
│   │   └── client/
│   │       ├── consortiums/   # CRUD + periods + invoices + scan + receipt
│   │       ├── providers/     # CRUD proveedores
│   │       ├── rubros/        # CRUD rubros (nivel cliente)
│   │       ├── coeficientes/  # CRUD coeficientes (nivel cliente)
│   │       ├── sync-directory/ # POST: sincroniza archivo ALTA (Sheets → DB)
│   │       └── import/        # importación Excel (+ template)
│   └── admin/
│       ├── consortiums/       # UI principal de gestión
│       ├── clients/
│       │   └── [id]/          # UI edición de configuración de cliente
│       └── page.tsx           # Panel admin principal
├── jobs/
│   ├── processPendingDocuments.job.ts  # ← PIPELINE PRINCIPAL
│   ├── scheduler.ts
│   └── jobWorkerMain.ts
├── lib/
│   ├── extraction.ts           # Prompts de extracción IA (facturas + LSP)
│   ├── consortiumNormalizer.ts # Normalización + fuzzy + alias match
│   ├── businessKey.ts          # Normalización de montos para deduplicación
│   └── clientProcessingConfig.ts
├── services/
│   ├── googleDrive.service.ts
│   ├── googleSheets.service.ts  # readDirectory() para sync ALTA
│   ├── geminiExtractor.service.ts
│   └── aiExtractor.service.ts
└── repositories/
    ├── consortium.repository.ts
    ├── invoice.repository.ts
    └── provider.repository.ts
```

---

## Schema de base de datos

```
Client          → Tenant. Roles: ADMIN / CLIENT / VIEWER
  ├── Consortium  → Edificio. canonicalName + rawName + cuit + aliases
  │   └── Period    → Período mensual. status: ACTIVE / CLOSED
  ├── Provider    → Proveedor. canonicalName + cuit + alias
  ├── Rubro       → Categoría de gasto (nivel cliente). name + description?
  ├── Coeficiente → Coeficiente de liquidación (nivel cliente). code + name
  ├── Invoice     → Boleta procesada. Liga a Consortium + Provider + Period
  │                 receiptDriveFileId / receiptDriveFileUrl (recibo de pago)
  ├── Receipt     → Recibo de pago (modelo separado, relacionado 1:1 con Invoice)
  ├── ProcessingJob → Cola de jobs (PENDING/PROCESSING/COMPLETED/FAILED)
  ├── SchedulerState → Estado runtime del scheduler por cliente
  │                    lastDirectorySyncAt: última sincronización ALTA
  ├── ProcessingLog  → Historial de ejecuciones
  └── TokenUsage     → Consumo de tokens IA por run
```

> **Nota:** Rubro y Coeficiente son a nivel CLIENT (no por consorcio).

### Campos importantes en Invoice
- `boletaNumberNorm`, `providerTaxIdNorm`, `dueDateNorm`, `amountNorm` → business key para deduplicación
- `isDuplicate` → flag (sigue yendo a Sheets, no se mueve en Drive)
- `tipoGasto` → enum: ORDINARIO / EXTRAORDINARIO / PARTICULAR
- `tipoComprobante` → string libre (A, B, C, Ticket, Recibo, etc.)
- `receiptDriveFileId` / `receiptDriveFileUrl` → recibo de pago adjunto manualmente desde UI

### Campos importantes en Consortium
- `aliases` → nombres alternativos separados por `|` para matching con LSP (Edesur, AySA, etc.)
  - Ejemplo: `"BROWN ALMTE AV 708|ALMIRANTE BROWN 708"`

### googleConfigJson por cliente
```json
{
  "clientEmail":   "...",
  "privateKey":    "[ENCRYPTED]",
  "sheetsId":      "ID_ARCHIVO_DATOS",
  "altaSheetsId":  "ID_ARCHIVO_ALTA",
  "geminiApiKey":  "[ENCRYPTED]",
  "openaiApiKey":  "[ENCRYPTED]"
}
```
- `sheetsId` → archivo de boletas (Datos)
- `altaSheetsId` → archivo ALTA separado para sync de directorio (Consorcios, Proveedores, Rubros, Coeficientes)
- `privateKey`, `geminiApiKey`, `openaiApiKey` se guardan **encriptados** en DB. Usar `resolveGoogleConfig(client)` para obtenerlos desencriptados.

---

## Feature: Sincronización Directorio ALTA (Sheets → DB)

### Flujo
1. Usuario crea un archivo Google Sheets llamado **"ALTA"** en Drive, lo comparte con la service account.
2. Configura el `altaSheetsId` en el panel (botón **Editar** por cliente → campo "ID archivo ALTA").
3. Aprieta **"Sincronizar directorio"** en el panel → la app lee el archivo ALTA → upserta en DB.
4. Primera sincronización: si las hojas no existen se crean automáticamente con encabezados.
5. El usuario carga datos y vuelve a sincronizar.

### Formato del archivo ALTA (4 hojas)
| Hoja | Col A | Col B | Col C |
|---|---|---|---|
| `_Consorcios` | NOMBRE CANÓNICO | CUIT | ALIASES (opcional, separado por `\|`) |
| `_Proveedores` | NOMBRE CANÓNICO | CUIT | ALIAS (opcional) |
| `_Rubros` | NOMBRE | DESCRIPCIÓN (opcional) | — |
| `_Coeficientes` | NOMBRE | CÓDIGO | — |

### Estrategia de sync por entidad
- **Rubro / Coeficiente**: reemplazo total (`deleteMany` + `createMany`) — no tienen FK que afecte invoices.
- **Consortium / Provider**: upsert + intento de delete de huérfanos. Si la FK falla → warning (no error fatal).

### Archivos clave
- `src/services/googleSheets.service.ts` → método `readDirectory()`: lee las 4 hojas, auto-crea las faltantes, retorna `DirectoryData`.
- `src/app/api/client/sync-directory/route.ts` → POST endpoint. Usa `resolveGoogleConfig(client)` para desencriptar la private key.
- `src/services/schedulerControl.service.ts` → propaga `lastDirectorySyncAt` en `toRuntimeState()`.

### Bug crítico resuelto
Siempre usar `resolveGoogleConfig(client)` para construir el `GoogleSheetsService` del archivo ALTA.
**Nunca** pasar `client.googleConfigJson.privateKey` directo — está encriptada → error `error:1E08010C:DECODER routines::unsupported`.

---

## Pipeline de procesamiento (processPendingDocuments.job.ts)

1. **Download** PDF desde Drive
2. **Dedup hash** → SHA256 del binario
3. **Extracción texto** → pdf-parse → fallback OCR (tesseract)
4. **Extracción IA** → Gemini → fallback OpenAI → fallback OCR_ONLY
5. **Dedup business key** → boletaNumber + providerTaxId + dueDate + amount
6. **Resolve assignment** → match consorcio + proveedor
7. **Canonización** → reemplazar datos OCR por datos canónicos de DB
8. **Insert Sheets** → fila con monto formateado en es-AR ($ 118.000,00)
9. **Mover archivo** → Escaneados (ok) / Sin Asignar (no matcheó)
10. **Guardar Invoice** + métricas

### Matching de consorcio (3 niveles, en orden)
1. **Exacto** → `normalizeConsortiumName(rawOcr) === canonicalName`
2. **Fuzzy** → todos los tokens de `canonicalName` aparecen en `rawOcr`
3. **Alias** → el rawOcr coincide con algún alias registrado en `consortium.aliases`

### Matching de proveedor (3 niveles)
1. **CUIT normalizado** (solo dígitos) — excluye el CUIT del consorcio
2. **Nombre exacto** o alias normalizado
3. **Nombre parcial** (substring)

---

## Extracción IA (src/lib/extraction.ts)

El sistema detecta automáticamente el tipo de documento y usa el prompt adecuado:

### Facturas normales (`buildInvoicePrompt`)
- `providerTaxId` = CUIT del **emisor** (NO el del consorcio receptor)
- `dueDate` = fecha de **pago** (NO fecha CAE, NO inicio de actividades)
  - Válido: campo junto a CUIT e inicio de actividades del proveedor en el encabezado
  - Inválido: `"Fecha Vto."` junto a `"CAE Nº:"` → es del código AFIP
- `amount` = Importe Total (nunca un subtotal)

### LSP — Liquidación de Servicios Públicos (`buildUtilityBillPrompt`)
Detectado automáticamente si el texto contiene: EDESUR, EDENOR, AYSA, AGUA Y SANEAMIENTOS, METROGAS, NATURGY, CAMUZZI, etc.

- `provider` = empresa de servicios (Edesur, AySA, etc.)
- `providerTaxId` = CUIT de la **empresa** (NO del cliente que aparece prominente)
- `consortium` = dirección del inmueble (calle + número, sin piso/depto/CP)
- `amount` = monto del **1° vencimiento** (ignorar 2°)
- `dueDate` = fecha del 1° vencimiento
  - Inválido: `"C.E.S.P: XXXXX | Fecha Vto: DD/MM"` → es del código CESP, no de pago
  - Inválido: `"Próxima liquidación vence..."` → es del próximo mes
  - Válido en AySA: `"Vencimiento 20/02/2026"` o `"A debitar el 23/02/2026"`

#### Formato observado en Edesur (para futura refactorización de prompt)
Del PDF real analizado:
- `boletaNumber`: dentro de `"LSP B 0501-73540975 18"` → extraer solo `0501-73540975`
- Dos vencimientos presentados así:
  ```
  Total a pagar hasta   Fecha límite de pago en banco
  18/02/2026 $121.670,97    23/02/2026 $122.078,88
  ```
  → usar siempre el **primer** par (fecha + monto)
- `consortium`: aparece bajo `"CONSORCIO DE PROPIETARIOS"` como cliente, seguido de la dirección del suministro
- `provider`: `"EDESUR S.A."` / CUIT: `30-71079642-7`

**Pendiente:** refactorizar `extraction.ts` para prompts por empresa (`buildEdesurPrompt`, `buildAysaPrompt`, etc.) con router `identifyLSPProvider()`.

### Regla crítica de dueDate (aplica a ambos tipos)
El vencimiento de PAGO siempre aparece asociado a un MONTO.
Si la fecha está junto a un número de CAE (secuencia larga de dígitos) → es del CAE → null.
Si la fecha dice explícitamente "para el pago" → siempre válida.
No deducir, no calcular. Ante la duda: null.

### Normalización de montos (src/lib/businessKey.ts → normalizeBusinessAmount)
Soporta todos los formatos para deduplicación:
- `118000` → `"118000.00"`
- `"$ 118.000,00"` (es-AR) → `"118000.00"`
- `"$ 118,000.00"` (en-US) → `"118000.00"`

### Formato en Google Sheets
Los montos se envían formateados como `"$ 118.000,00"` (es-AR) desde el backend.
No requiere configurar formato en la hoja.

---

## Normalización de consorcios (src/lib/consortiumNormalizer.ts)

```typescript
normalizeConsortiumName("CONSORCIO DE COPROPIETARIOS THAMES NUMEROS 647-649 CAPITAL F")
// → "THAMES 647"

normalizeConsortiumName("CONSORCIO DE PROPIETARIOS AV PUEYRREDON 2418")
// → "PUEYRREDON 2418"

normalizeConsortiumName("BROWN ALMTE AV 708")
// → "ALMIRANTE BROWN 708"  (expande abreviatura ALMTE)
```

**Prefijos reconocidos:** CONSORCIO DE COPROPIETARIOS / CONSORCIO DE PROPIETARIOS / CONSORCIO COPROPIETARIOS / CONSORCIO PROPIETARIOS / CONS. COPROPIET. / CONS. PROPIET. / CONS. PROP. / CONSORCIO CALLE / CONSORCIO

**Tipos de vía:** AV / AVDA / AVENIDA / CALLE / BLVD / DIAGONAL / PASAJE / PJE / RUTA / etc.

**Abreviaturas de calle expandidas:** ALMTE→ALMIRANTE, GRAL→GENERAL, CNEL→CORONEL, DR→DOCTOR, ING→INGENIERO, PRES→PRESIDENTE, BV→BOULEVARD, etc.

**Palabras ruido eliminadas:** NUMEROS / NRO / N° / NUM entre nombre y número

**Número distinto entre factura y DB (ej: Edesur 708 vs DB 706):**
No se puede resolver automáticamente. Registrar alias en Supabase:
```sql
UPDATE "Consortium"
SET aliases = 'BROWN ALMTE AV 708|ALMIRANTE BROWN 708'
WHERE "canonicalName" = 'ALMIRANTE BROWN 706';
```

---

## Importación masiva desde Excel

**Endpoint:** `POST /api/client/import`
**Template:** `GET /api/client/import/template` (descarga .xlsx de ejemplo)

Hoja `Edificios`:
| Nombre | CUIT | Aliases |
|--------|------|---------|
| ARENALES 2154 | 30-52312872-4 | CONS PROP ARENALES\|ARENALES 56 |

Hoja `Proveedores`:
| Nombre | CUIT | Alias |
|--------|------|-------|
| TIGRE ASCENSORES S.A. | 27-33906838-6 | TIGRE ASCENSORES |

- Alias en edificios: separados por `|`
- Alias en proveedores: campo único opcional (celda vacía = null)
- Duplicados: se omiten (skip), no sobreescriben
- Requiere `npm install xlsx` antes de usar

---

## Recibo de pago

**Endpoint:** `POST /api/client/consortiums/:id/invoices/:invoiceId/receipt`

Sube PDF de recibo a Drive en:
```
[receipts folder del cliente]
  └── [Nombre consorcio]
        └── [Mes Año]
              └── recibo.pdf
```

Si no hay `receipts` folder → usa `scanned` como raíz.
Los campos `receiptDriveFileId` y `receiptDriveFileUrl` se guardan en Invoice.

---

## Configuración por cliente (driveFoldersJson)

```json
{
  "pending":    "ID_CARPETA_PENDIENTES",
  "scanned":    "ID_CARPETA_ESCANEADOS",
  "unassigned": "ID_CARPETA_SIN_ASIGNAR",
  "failed":     "ID_CARPETA_FALLIDOS",
  "receipts":   "ID_CARPETA_RECIBOS"
}
```

Diagnóstico: `npx tsx scripts/fix-client-folders.ts`

---

## Autenticación

- Cookie `dpp_session` (httpOnly, sameSite=lax)
- JWT con 24h de expiración
- Middleware (`middleware.ts`) usa Web Crypto API (Edge Runtime compatible)
- Roles: ADMIN / CLIENT / VIEWER

---

## Google Sheets — columnas por defecto

```
A = boletaNumber     G = dueDate
B = provider         H = amount  (formato: "$ 118.000,00")
C = consortium       I = alias
D = providerTaxId    J = sourceFileUrl
E = detail           K = isDuplicate
F = observation
```

Customizable por cliente en `extractionConfigJson.columnMapping`.

---

## Convenciones de código

- **PowerShell:** No usar `&&`. Siempre comandos por separado.
- **Migraciones:** `npx prisma migrate deploy` → `npx prisma generate`. Nunca modificar tablas en Supabase Studio directamente.
- **Prisma generate:** Parar todos los procesos antes (el `.dll` queda bloqueado en Windows).
- **Edge Runtime (`middleware.ts`):** Usar Web Crypto API, no `import { createHmac } from "crypto"`.
- **Tokens de IA:** `extractRelevantLines(text, 80)` — primeras 80 líneas no vacías.
- **Formato de monto:** siempre `es-AR` con `Intl.NumberFormat`.
- **clientAuth vs adminAuth:** usar `requireClientSession` para endpoints de clientes, `requireAuthenticatedSession` para los del panel admin.

---

## Pendientes conocidos

### Migraciones pendientes de aplicar
> **Parar los 3 procesos antes** (el `.dll` de Prisma queda bloqueado en Windows).
```powershell
npx prisma migrate deploy
npx prisma generate
```
Migraciones incluidas:
- `20260319000300_consortium_aliases` → agrega campo `aliases` a Consortium
- `20260320000100_rubro_coeficiente_to_client_level` → tablas Rubro + Coeficiente a nivel cliente + `lastDirectorySyncAt` en SchedulerState

### Features pendientes
- [ ] **Prompts LSP por empresa**: refactorizar `extraction.ts` para tener `buildEdesurPrompt()`, `buildAysaPrompt()`, etc. con función `identifyLSPProvider()` como router. Ver sección LSP arriba para formato Edesur documentado.
- [ ] `npm install xlsx` (requerido para importación Excel — no está en package.json aún)
- [ ] UI de edición de aliases de consorcio (hoy solo via SQL en Supabase)
- [ ] UI de gestión de carpetas Drive por cliente desde el panel
- [ ] Resincronización automática con Sheets cuando Google falla
- [ ] Agregar URL de recibo a columna de Google Sheets
- [ ] UI para asignar Rubro y Coeficiente a invoices individuales desde el panel (Stage 2)

---

## Variables de entorno requeridas

```env
DATABASE_URL=               # PostgreSQL Supabase (pooler)
DIRECT_URL=                 # PostgreSQL Supabase (directo, para migraciones)
SESSION_SECRET=             # JWT signing key (mín 32 chars)
PROCESS_INTERVAL_MINUTES=   # Intervalo scheduler (ej: 5)

# Opcionales (fallback global si el cliente no tiene config propia)
GOOGLE_CLIENT_EMAIL=
GOOGLE_PRIVATE_KEY=
GOOGLE_DRIVE_PENDING_FOLDER_ID=
GOOGLE_DRIVE_SCANNED_FOLDER_ID=
GOOGLE_SHEETS_ID=
GOOGLE_SHEETS_SHEET_NAME=
GEMINI_API_KEY=
GEMINI_MODEL=
OPENAI_API_KEY=
OPENAI_MODEL=
GOOGLE_CREDENTIALS_ENCRYPTION_KEY=   # default: SESSION_SECRET
```
