# Drive Doc Processor

Sistema multi-tenant para administrar consorcios de propiedad horizontal en Argentina. Procesa automáticamente PDFs de facturas y boletas desde Google Drive usando IA, extrae datos estructurados, los guarda en base de datos y los envía a Google Sheets.

## Stack

- **Frontend/API:** Next.js 16 + TypeScript + React 19
- **Base de datos:** PostgreSQL (Supabase) + Prisma ORM
- **IA:** Google Gemini (primario) + OpenAI (fallback)
- **Servicios externos:** Google Drive, Google Sheets
- **OCR:** Tesseract.js + @napi-rs/canvas + pdfjs-dist
- **Infraestructura:** Docker + Cloudflare Tunnel + GitHub Actions CI/CD

## Arquitectura

El sistema corre como **3 procesos independientes**:

| Proceso | Responsabilidad |
|---------|-----------------|
| **Web** | UI + API REST + autenticación (Next.js standalone) |
| **Scheduler** | Escanea Google Drive por cliente y encola `ProcessingJob` |
| **Worker** | Procesa la cola: descarga PDF, extrae con IA, guarda en DB, envía a Sheets |

### Pipeline de procesamiento

1. Descarga PDF desde Google Drive
2. Deduplicación por hash SHA256
3. Extracción de texto (pdf-parse, fallback OCR con Tesseract)
4. Detección automática de tipo de documento (router LSP por empresa)
5. Extracción IA con prompt específico (Gemini, fallback OpenAI, fallback OCR_ONLY)
6. Deduplicación por clave de negocio (boletaNumber + providerTaxId + dueDate + amount)
7. Matching de consorcio (exacto, fuzzy, alias) y proveedor (CUIT, nombre, parcial)
8. Canonización con datos de DB
9. Inserción en Google Sheets (formato es-AR)
10. Mover archivo a carpeta correspondiente + guardar Invoice en DB

### Empresas de servicios (LSP) soportadas

Router `identifyLSPProvider()` con prompts dedicados para: **Edesur, Edenor, AySA, Metrogas, Naturgy, Camuzzi, Litoral Gas**. CUIT hardcodeado por empresa para evitar confusión con el CUIT del consorcio. Fallback a prompt genérico LSP o prompt de factura normal.

## Docker (producción)

### Requisitos

- Docker y Docker Compose
- Archivo `.env` en la raíz (copiar de `.env.example`)
- Token de Cloudflare Tunnel (opcional, para acceso externo)

### Levantar

```bash
# Build + levantar los 4 servicios
docker compose up --build -d

# Ver logs
docker compose logs -f

# Solo un servicio
docker compose logs -f web

# Bajar
docker compose down
```

### Servicios

| Servicio | Puerto | Descripción |
|----------|--------|-------------|
| `web` | 3000 | Next.js standalone + API, healthcheck integrado |
| `scheduler` | - | Escanea Drive cada N minutos |
| `worker` | - | Procesa cola de jobs |
| `tunnel` | - | Cloudflare Tunnel (opcional) |

Los 3 servicios de la app comparten la misma imagen Docker (`drive-doc-processor:latest`). Solo `web` tiene `build:`, scheduler y worker reusan la imagen.

### Imagen Docker

- **Base:** `node:20-bookworm-slim` (Debian, NO Alpine — requerido por `@napi-rs/canvas`)
- **Multi-stage:** deps, prod-deps, builder, runner
- **Runtime:** incluye `tesseract-ocr` (spa + eng), corre como usuario `nextjs` (no root)

## Desarrollo local

### Requisitos

- Node.js 20+
- PostgreSQL (o Supabase)
- Archivo `.env` (copiar de `.env.example`)

### Instalación

```bash
npm install
npx prisma generate
npx prisma migrate deploy
```

### Crear usuario admin

```bash
npx tsx scripts/create-admin.ts admin@empresa.com MiPassword123
```

### Levantar los 3 procesos

```powershell
# Windows (abre 3 terminales automáticamente)
npm run local

# O manualmente en 3 terminales separadas:
npm run dev        # Web (puerto 3000)
npm run schedule   # Scheduler
npm run worker     # Worker
```

> Los 3 procesos deben estar corriendo para que el pipeline funcione. Solo `npm run dev` levanta la UI pero no procesa PDFs.

## Scripts

| Script | Descripción |
|--------|-------------|
| `npm run dev` | Servidor Next.js en modo desarrollo |
| `npm run build` | Build de producción (Next.js standalone) |
| `npm run build:jobs` | Compila scheduler + worker a `dist/` |
| `npm run start` | Servidor de producción |
| `npm run typecheck` | Verificación de tipos TypeScript |
| `npm run lint` | ESLint |
| `npm run check` | Pipeline completo: generate + lint + typecheck + build:jobs |
| `npm run schedule` | Ejecuta el scheduler (dev, con tsx) |
| `npm run worker` | Ejecuta el worker (dev, con tsx) |
| `npm run local` | Levanta los 3 procesos (Windows/PowerShell) |
| `npm run diagnose -- <fileId>` | Diagnóstico de acceso a archivo en Drive |
| `npm run diagnose:db` | Diagnóstico de conexión a DB |
| `npm run diagnose:gemini` | Test de extracción con Gemini |

## Variables de entorno

Ver `.env.example` para la lista completa con descripciones.

### Requeridas

| Variable | Descripción |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection pooler URL |
| `DIRECT_URL` | PostgreSQL directo (para migraciones) |
| `SESSION_SECRET` | JWT signing key (mín 32 chars) |
| `PROCESS_INTERVAL_MINUTES` | Intervalo del scheduler en minutos |

### Opcionales (fallback global)

Credenciales de Google, claves de IA (Gemini/OpenAI), y configuración de Drive/Sheets. Cada cliente puede tener su propia configuración almacenada encriptada en DB, las variables globales actúan como fallback.

### Docker

| Variable | Descripción |
|----------|-------------|
| `CLOUDFLARE_TUNNEL_TOKEN` | Token de Cloudflare Tunnel |

## Sistema multi-tenant

- **ADMIN** — gestiona clientes, ve métricas agregadas, auditoría
- **CLIENT** — opera su scheduler, ejecuta corridas manuales, gestiona consorcios/proveedores
- **VIEWER** — acceso de solo lectura

Cada cliente tiene:
- Credenciales Google propias (encriptadas en DB)
- Carpetas Drive configurables (pendientes, escaneados, sin asignar, fallidos, recibos)
- Archivo Google Sheets para datos + archivo ALTA para sincronización de directorio
- Claves IA propias (Gemini/OpenAI) opcionales

## Features principales

- Pipeline automático de procesamiento de PDFs con extracción IA
- Prompts LSP dedicados por empresa de servicios (7 empresas + genérico)
- Normalización de direcciones: expansión de abreviaturas, limpieza de ceros, CP, piso/depto
- Matching de consorcios en 3 niveles: exacto, fuzzy (tokens), alias
- Matching de proveedores: CUIT normalizado, nombre exacto/alias, nombre parcial
- Deduplicación por hash SHA256 y clave de negocio
- Sincronización de directorio desde archivo ALTA (Sheets a DB)
- Importación masiva desde Excel (edificios + proveedores)
- Recibo de pago: subida a Drive organizada por consorcio/período
- Logging estructurado con timestamps y separadores visuales

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`) con 3 jobs:

1. **Check** — lint + typecheck + build:jobs
2. **Build** — Docker build con cache GHA (BuildKit)
3. **Deploy** — Solo en push a `master`, corre en self-hosted runner

## Estructura del proyecto

```
src/
├── app/                    # Next.js App Router (UI + API)
│   ├── api/
│   │   ├── auth/          # Login / logout / me
│   │   ├── admin/         # Panel admin (clientes, auditoría, scheduler)
│   │   └── client/        # Operaciones de cliente (consorcios, proveedores, sync, import)
│   └── admin/             # UI del panel admin
├── jobs/                  # Scheduler + Worker + Pipeline principal
├── lib/                   # Lógica core (extracción IA, normalización, matching, logger)
├── services/              # Servicios externos (Drive, Sheets, Gemini, OpenAI, OCR)
├── repositories/          # Capa de acceso a datos (Prisma)
├── config/                # Variables de entorno
├── types/                 # Definiciones TypeScript
└── utils/                 # Utilidades (encriptación)
```

## Modelos principales (Prisma)

| Modelo | Descripción |
|--------|-------------|
| `Client` | Tenant/usuario con roles y configuración |
| `Consortium` | Edificio (canonicalName + aliases + CUIT) |
| `Provider` | Proveedor (canonicalName + CUIT + alias) |
| `Period` | Período mensual por consorcio (ACTIVE/CLOSED) |
| `Invoice` | Factura procesada con datos extraídos |
| `Rubro` | Categoría de gasto (nivel cliente) |
| `Coeficiente` | Coeficiente de liquidación (nivel cliente) |
| `ProcessingJob` | Cola persistente de procesamiento |
| `SchedulerState` | Estado runtime del scheduler por cliente |
| `ProcessingLog` | Historial de ejecuciones |
| `TokenUsage` | Consumo de tokens IA por corrida |

## Documentación interna

- `CLAUDE.md` — Contexto completo del proyecto para desarrollo con IA
- `docs/progreso.md` — Estado actual de features y tareas
- `docs/decisiones.md` — Registro de decisiones técnicas

## Licencia

Privado.
