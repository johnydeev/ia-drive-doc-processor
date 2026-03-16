# Drive Doc Processor

Backend multi-tenant en `Next.js + TypeScript` para procesar comprobantes PDF desde Google Drive, extraer datos con IA/OCR, cargar resultados en Google Sheets y mantener trazabilidad en PostgreSQL.

## Estado actual del sistema
- Multi-tenant por cliente (`Client`) con roles `ADMIN`, `CLIENT`, `VIEWER`.
- Scheduler automatico por cliente (solo `CLIENT` activos) que encola trabajos en `ProcessingJob`.
- Workers procesan la cola de trabajos y ejecutan el pipeline de PDFs.
- Asignacion de consorcio/proveedor/periodo a partir de la extraccion (auto-creacion si aplica).
- Gestión de consorcios con cierre de períodos.
- Control `ON/OFF` por cliente desde el dashboard.
- Dashboard admin con:
  - alta de clientes (rol `CLIENT`),
  - metricas por cliente,
  - estado agregado del scheduler y consumo de tokens.
- Dashboard cliente con:
  - control de su propio scheduler,
  - ejecucion manual,
  - resumen de ultima corrida, tokens y cuota estimada.
- Dashboard viewer: acceso de solo lectura (sin controles).
- Autenticacion por cookie httpOnly con expiracion de token a 24h.
- Persistencia en PostgreSQL (Prisma).
- Deteccion de duplicados por hash y clave de negocio.

## Flujo de procesamiento (por cliente)
1. Scheduler escanea la carpeta `Pendientes` y crea `ProcessingJob` por PDF.
2. Worker toma un job pendiente.
3. Descarga PDF.
4. Extrae texto:
  - texto embebido directo (pdf-parse),
  - fallback OCR con `tesseract.js` + `pdfjs-dist` si no hay texto.
5. Extrae JSON estructurado con IA:
  - intenta Gemini (config cliente o global),
  - luego OpenAI (config cliente o global),
  - si fallan ambos => `OCR_ONLY`.
6. Detecta duplicado:
  - por `documentHash` (sha256),
  - por clave de negocio normalizada.
7. Asigna consorcio/proveedor/periodo si hay datos extraidos.
8. Inserta fila en Google Sheets.
9. Mueve archivo a carpeta `Escaneados`.
10. Registra logs, totales y tokens en DB.

## Arquitectura resumida
- API/UI: Next.js App Router (`src/app`).
- Scheduler (job creator): proceso separado (`src/jobs/scheduler.ts`) que encola en `ProcessingJob`.
- Worker (job processor): proceso separado (`src/jobs/jobWorkerMain.ts`) que consume la cola.
- Flujo: Drive scan -> `ProcessingJob` queue -> Workers -> pipeline de procesamiento.
- Persistencia: Prisma + PostgreSQL (`prisma/schema.prisma`).
- Servicios:
  - Drive: `src/services/googleDrive.service.ts`
  - Sheets: `src/services/googleSheets.service.ts`
  - OCR: `src/services/ocr.service.ts`
  - PDF text: `src/services/pdfTextExtractor.service.ts`
  - Gemini: `src/services/geminiExtractor.service.ts`
  - OpenAI: `src/services/aiExtractor.service.ts`

## Modelos principales (Prisma)
- `Client`: usuario/tenant con config de Drive/Sheets e IA.
- `Invoice`: factura procesada + metadatos + deduplicacion.
- `ProcessingJob`: cola persistente de procesamiento.
- `ProcessingLog`: historial de ejecuciones.
- `SchedulerState`: estado runtime y acumulados por cliente.
- `TokenUsage`: consumo de tokens por corrida/proveedor/modelo.
- `Consortium`: consorcios por cliente (nombre normalizado + nombre original).
- `Provider`: proveedores por cliente.
- `ConsortiumProvider`: relacion many-to-many entre consorcios y proveedores.
- `Period`: periodos por consorcio (status `ACTIVE`/`CLOSED`).

## Variables de entorno
### Requeridas
- `DATABASE_URL`
- `PROCESS_INTERVAL_MINUTES`
- `SESSION_SECRET`

### Requeridas para migraciones Prisma
- `DIRECT_URL`

### Opcionales (fallback global)
Estas son opcionales porque el modo recomendado es usar credenciales por cliente en DB:
- `GOOGLE_PROJECT_ID`
- `GOOGLE_CLIENT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `GOOGLE_DRIVE_PENDING_FOLDER_ID`
- `GOOGLE_DRIVE_SCANNED_FOLDER_ID`
- `GOOGLE_SHEETS_ID`
- `GOOGLE_SHEETS_SHEET_NAME` (default interno: `Datos`)
- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `GOOGLE_CREDENTIALS_ENCRYPTION_KEY` (si no esta, se usa `SESSION_SECRET` para cifrar)

## Configuracion local
1. Instalar dependencias:
```bash
npm install
```

2. Crear/ajustar entorno:
Crear `.env.local` con las variables requeridas.

3. Generar cliente Prisma:
```bash
npm run prisma:generate
```

4. Aplicar migraciones:
```bash
npm run prisma:migrate:deploy
```

## Ejecutar en desarrollo
Necesitas 3 procesos:

1. Web/API:
```bash
npm run dev
```

2. Scheduler (crea jobs):
```bash
npm run schedule
```

3. Worker (procesa jobs):
```bash
npm run worker
```

Si solo ejecutas `npm run dev`, no hay procesamiento automatico.
Si queres levantar todo en paralelo:
```bash
powershell -ExecutionPolicy Bypass -File scripts/run-local.ps1
```

## Scripts utiles
- `npm run dev`: levanta Next en desarrollo.
- `npm run schedule`: levanta loop automatico.
- `npm run worker`: procesa jobs pendientes.
- `npm run build`: build de produccion.
- `npm run start`: servidor de produccion.
- `npm run prebuild:check`: prisma generate + tsc + prisma validate.
- `npm run diagnose -- <fileId>`: diagnostico Drive por archivo.
- `npm run diagnose:gemini`: test de extraccion Gemini.
- `npm run diagnose:db`: diagnostico de conexion DB.
- `npm run prisma:migrate:deploy`: aplica migraciones.

## Endpoints principales
### Auth
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/auth/register` -> deshabilitado (retorna 403)

### Procesamiento
- `POST /api/process` -> ejecuta corrida manual global (sin autenticacion).

### Admin / Scheduler
- `GET /api/admin/scheduler/status` (admin ve agregado, cliente ve su propio estado)
- `POST /api/admin/scheduler/toggle` (solo rol `CLIENT`)
- `POST /api/admin/scheduler/run` (solo rol `CLIENT`)
- `GET /api/admin/audit/clients` (solo rol `ADMIN`)
- `POST /api/admin/clients` (solo rol `ADMIN`)

### Consorcios (cliente)
- `GET /api/client/consortiums`
- `POST /api/client/consortiums`
- `GET /api/client/consortiums/:id`
- `POST /api/client/consortiums/:id/close-period`

### Documentacion API
- Swagger UI: `GET /api-docs`
- Alias: `GET /docs`
- OpenAPI JSON: `GET /api/openapi`

## Alta de cliente (desde panel ADMIN)
Se guarda en DB:
- Datos de cuenta: nombre, email, password temporal.
- Drive:
  - `driveFolderPending`
  - `driveFolderProcessed`
- Sheets:
  - `sheetsId`
  - `sheetName`
- Service account Google (en JSON o campos sueltos):
  - `projectId`
  - `clientEmail`
  - `privateKey`
- IA opcional por cliente:
  - `geminiApiKey`
  - `openaiApiKey`

## Validaciones importantes por cliente
Antes de procesar se valida:
- `driveFolderPending` obligatorio.
- `driveFolderProcessed` obligatorio.
- Pendientes y Escaneados deben ser distintos.
- `sheetName` obligatorio.
- Credenciales Google completas (`projectId/clientEmail/privateKey/sheetsId`).

Si falta algo, se registra error explicito por cliente en la corrida.

## Deduplicacion
- `documentHash` (sha256) por cliente.
- clave de negocio normalizada por cliente:
  - `boletaNumberNorm`
  - `providerTaxIdNorm`
  - `dueDateNorm`
  - `amountNorm`

## Docker
### Compose (actual)
- `docker-compose.yml`:
  - `web` (Next/API + scheduler)
  - `worker` (job worker)

Levantar:
```bash
docker compose up -d --build
```

Logs:
```bash
docker compose logs -f web
docker compose logs -f worker
```

## Checklist de produccion
### Seguridad
- Definir `SESSION_SECRET` fuerte (minimo 32 bytes aleatorios).
- Verificar que no haya credenciales reales en repositorio ni `.env` versionados.
- Rotar claves de service account y API keys antes de go-live.
- Forzar HTTPS y dominio final en el reverse proxy.

### Base de datos
- `DATABASE_URL` y `DIRECT_URL` apuntando a la DB productiva.
- Ejecutar `npm run prisma:migrate:deploy`.
- Confirmar que existe al menos un usuario `ADMIN`.

### Scheduler y worker
- Levantar `web` y `worker` (no solo `web`).
- Verificar en logs que aparezca: `[scheduler] starting. Interval: ...`.
- Verificar en logs del worker: `[job-worker] starting`.
- Confirmar que cada cliente con rol `CLIENT` puede activar/desactivar su scheduler.

### Integraciones por cliente
- Validar `driveFolderPending` y `driveFolderProcessed` (distintos).
- Validar `googleConfigJson` completo (`projectId/clientEmail/privateKey/sheetsId`).
- Compartir carpetas Drive y archivo Sheets al service account correspondiente.
- Confirmar `sheetName` correcto.

### Pruebas funcionales minimas
- Login ADMIN y CLIENT.
- Alta de cliente desde panel ADMIN.
- Toggle scheduler ON/OFF por cliente.
- Corrida manual (`Ejecutar ahora`) y corrida automatica.
- Verificar insercion en Sheets y movimiento a carpeta Escaneados.
- Verificar deduplicacion por hash y clave de negocio.

## Seguridad y sesiones
- Cookie `httpOnly`, `sameSite=lax`.
- Session cookie (se elimina al cerrar sesion de navegador).
- Token con expiracion dura de 24 horas.
- `SESSION_SECRET` obligatorio.

## Troubleshooting rapido
### `Unexpected token '<' ... is not valid JSON`
- Normalmente significa que un endpoint devolvio HTML por error 500.
- Revisar logs del server para identificar variable/config faltante.

### Scheduler no corre automatico
- Verificar que `npm run schedule` este activo (o proceso scheduler en `web` en Docker).
- Verificar `PROCESS_INTERVAL_MINUTES`.
- Verificar que el cliente tenga scheduler en `ON`.

### Worker no procesa jobs
- Verificar que el servicio `worker` este activo.
- Verificar `GOOGLE_CREDENTIALS_ENCRYPTION_KEY` en el entorno del worker.

---
Si agregamos funcionalidades nuevas, este README debe actualizarse en la misma PR para mantener trazabilidad del producto.
