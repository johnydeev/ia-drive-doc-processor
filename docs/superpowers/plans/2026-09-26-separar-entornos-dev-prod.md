# Separar el entorno de desarrollo del de producción

> **Por qué:** el 2026-09-24 un comando de Prisma corrido por Claude vació la base de producción
> porque el `.env` local apuntaba a ella (ver `docs/decisiones.md`). Las reglas escritas no alcanzaron.
> **Objetivo:** que desde la carpeta del proyecto sea **imposible** escribir en producción por
> accidente — no que "haya que acordarse".
>
> **Este repo NO se commitea desde Claude.** Cada tarea termina en "verificar y avisar al owner".
> Las tareas marcadas **[OWNER]** tocan producción o secretos: las ejecuta el owner, nunca Claude.

---

## Estado de partida (verificado el 2026-09-26)

| Pieza | Hoy |
|---|---|
| Contenedores de producción | Leen el `.env` que el deploy escribe desde el secret `PROD_ENV_FILE`, en la carpeta del runner. **Ya separados** de la carpeta del proyecto |
| `.env` de la carpeta del proyecto | **Credenciales de producción**: lo usan `npm run dev`, Prisma, los scripts y Claude |
| `npm run db:migrate` | Backup + `prisma migrate deploy` + `generate` **desde la PC, contra producción** |
| Migraciones en el deploy | El CI corre `prisma migrate deploy` antes del `up`, **sin backup previo** |
| Conector MCP de Supabase | Conectado con permisos de escritura (`execute_sql`, `apply_migration`) |
| Base de desarrollo | No existe |

## Decisiones (defaults recomendados — confirmar al arrancar)

1. **Base de desarrollo en Postgres local (Docker)**, cargada desde un backup propio. No en un
   segundo proyecto de Supabase (el Free tiene tope de proyectos activos).
2. **Los contenedores de producción sólo los crea el deploy.** Desde la PC: `stop` / `start` /
   `restart` / `exec`, nunca `up` ni `run` (releen el `.env` local, que pasa a ser el de desarrollo).
3. **Usuario de sólo lectura** en Supabase para diagnosticar producción desde la PC.

## Diseño final

```
Carpeta del proyecto (.env)          Runner del deploy (.env desde PROD_ENV_FILE)
  DATABASE_URL  → Postgres local         DATABASE_URL → Supabase (producción)
  ENCRYPTION_KEY distinta                ENCRYPTION_KEY real
  PROD_READONLY_URL → Supabase RO        ↓
  ↓                                      contenedores web/worker/scheduler/db-backup
  npm run dev (puerto 3001)              migraciones: SÓLO acá, con backup antes
  npm run db:migrate (contra dev)
  scripts de diagnóstico (RO)
```

La clave de cifrado distinta es deliberada: la base de desarrollo tiene los datos reales, pero **no
puede descifrar las credenciales de Google** de los clientes → es imposible que un `npm run dev` o un
worker local mueva PDFs de Drive o escriba en la hoja Datos real.

---

## Tareas

### Tarea 1 — [OWNER] Usuario de sólo lectura en Supabase

SQL a correr en Supabase → SQL Editor (Claude lo prepara, el owner lo ejecuta):

```sql
create role ddp_readonly with login password '<generar una larga>';
grant connect on database postgres to ddp_readonly;
grant usage on schema public to ddp_readonly;
grant select on all tables in schema public to ddp_readonly;
alter default privileges in schema public grant select on tables to ddp_readonly;
alter role ddp_readonly set default_transaction_read_only = on;
```

- En el pooler de Supabase el usuario va como `ddp_readonly.<project-ref>`.
- **Verificar**: con esa URL, un `select count(*) from "Consortium"` funciona y un
  `update "Consortium" set …` falla con `permission denied` / `read-only transaction`.
- `alter default privileges` hace que las tablas de migraciones futuras también se puedan leer.

### Tarea 2 — Base de desarrollo local

- `docker-compose.dev.yml` con un servicio `db-dev` (`postgres:17`, puerto **5433** — el 5432 lo usa
  `turnero_postgres`), **volumen con nombre** (no bind mount: Docker Desktop cuelga la creación con
  carpetas de Windows, ver decisiones 2026-09-26).
- `npm run dev:db:up` → levanta `db-dev`.
- `npm run dev:db:load` → copia el último `backups/db_*.dump` adentro (`docker cp`) y lo restaura con
  el filtro de `SCHEMA public` (procedimiento del simulacro). Sirve también para "resetear" dev.
- **Verificar**: conteos de dev = conteos del backup usado.

### Tarea 3 — [OWNER] Reescribir el `.env` local

Claude prepara `.env.example` con la forma nueva; el owner edita el `.env` real (Claude no lee
secretos):

- `DATABASE_URL` / `DIRECT_URL` → `postgresql://postgres:<pass>@localhost:5433/postgres`
- `GOOGLE_CREDENTIALS_ENCRYPTION_KEY` y `SESSION_SECRET` → **valores nuevos**, distintos de producción.
- `PROD_READONLY_URL` → la URL del usuario de la Tarea 1.
- Fuera: `CEREBRAS_API_KEY`, `GROQ_API_KEY`, `CLOUDFLARE_TUNNEL_TOKEN` y cualquier otra credencial real
  (las keys de IA, si hacen falta para probar, con cuota/proyecto propio de dev).
- Queda `BACKUP_HOST_DIR` (lo necesita compose para interpolar el archivo).
- **Antes de pisarlo**: guardar el `.env` viejo en un gestor de contraseñas (es la única copia legible
  del secret `PROD_ENV_FILE`) y borrarlo de la PC.
- `npm run dev` pasa a `next dev -p 3001`: el 3000 lo ocupa el `web` de producción.

### Tarea 4 — Migraciones: dev desde la PC, producción sólo por el deploy

- `npm run db:migrate` queda `prisma migrate deploy && prisma generate` **contra dev**: sirve para
  probar la migración antes de commitearla. Sin `db:backup` (dev se recarga con `dev:db:load`).
- `npm run db:backup` sigue igual (usa `docker compose exec` → env del contenedor de producción).
- **CI**: antes del paso `prisma migrate deploy`, `prisma migrate status` (sólo lee). **Sólo si hay
  migraciones pendientes**, un backup en el momento (`docker compose exec -T db-backup bash
  /tmp/db-backup.sh now`). El deploy corre `migrate deploy` en cada commit aunque no haya nada: sin
  este filtro habría un backup por deploy, varios por día, sin necesidad.
  - Nombre distinguible: `db_<fecha>_<hora>_pre-migracion.dump` (el script acepta un sufijo). La
    retención de 30 días (`db_*.dump`) los cubre igual.
  - Complementa al diario, no lo reemplaza: el diario es la red general; éste deja el punto exacto
    antes de un cambio de estructura.
  - **Decidido (owner, 2026-09-26): con una migración pendiente, si el backup falla el deploy SE
    FRENA** — antes del `migrate deploy` y antes del `up`. La base no cambia y los contenedores
    viejos siguen corriendo (código viejo + base vieja, compatibles); sólo se demora el código nuevo
    hasta que el backup ande y se relance el deploy. Nunca se migra sin punto de vuelta.
    Sin migraciones pendientes no se hace backup, así que un `db-backup` caído no frena nada.
  - Diferencia con el run #159: ahí el corte fue DESPUÉS de recrear los contenedores; acá es antes.
- Actualizar `CLAUDE.md` → "Procedimiento de migración".

### Tarea 5 — Diagnósticos contra producción, en sólo lectura

- Los scripts que leen producción (`preflight-drive`, `diag-sheets-consistency`, `diag-boleta`…) se
  corren con `DATABASE_URL` pisada por `PROD_READONLY_URL`. Un `npm run diag:prod -- <script>` que lo
  haga solo.
- Los que ESCRIBEN (`fix-client-folders`, `normalize-cuits-db`, `rotate-encrypted-secrets`) van a
  fallar con esa URL — es lo buscado. Si alguna vez hay que correrlos en producción, se hace a mano,
  con backup antes, y lo decide el owner.

### Tarea 6 — Barreras en Claude Code

- **Hook `PreToolUse`** en `.claude/settings.json` (script en `.claude/hooks/`) que **bloquea** un
  comando Bash si contiene:
  - el host de Supabase de producción (`pooler.supabase.com`) — salvo el usuario `ddp_readonly`;
  - `--shadow-database-url`, `prisma migrate (diff|dev|reset|resolve)`, `prisma db (push|execute|seed)`;
  - `pg_restore` / `psql` contra cualquier host que no sea `localhost`.
- Reglas `deny` complementarias para `Read` de archivos de secretos fuera del proyecto.
- **Conector MCP de Supabase**: pasarlo a `read_only=true` y limitado a un proyecto, o desconectarlo.
- **Verificar**: un comando de prueba con `--shadow-database-url` (sin URL real) queda bloqueado.

### Tarea 7 — Documentación y cierre

- `CLAUDE.md`: sección de entornos (diagrama de arriba), migraciones, regla de "producción sólo por
  el deploy", comandos `dev:db:*` y `diag:prod`.
- `docs/decisiones.md`: entrada con el diseño y las alternativas descartadas.
- `docs/progreso.md` + `CHANGELOG.md`.
- Actualizar la memoria de Claude (`never-shadow-db-production`) con las barreras nuevas.

---

## Orden y quién hace qué

| # | Tarea | Quién | Toca producción |
|---|---|---|---|
| 1 | Usuario de sólo lectura | Owner (Claude prepara el SQL) | Sí — crea un rol |
| 2 | Base de desarrollo local | Claude | No |
| 3 | Reescribir `.env` | Owner (Claude prepara el ejemplo) | No (sí guarda el secret) |
| 4 | Migraciones dev / CI con backup | Claude | Al commitear (deploy) |
| 5 | Diagnósticos en sólo lectura | Claude | Sólo lectura |
| 6 | Hook + deny + MCP | Claude (MCP: owner) | No |
| 7 | Documentación | Claude | No |

**Criterio de terminado:** con el `.env` local nuevo, ningún comando corrido desde la carpeta del
proyecto puede escribir en la base de producción — ni por URL (no está), ni por el usuario de lectura
(Postgres lo rechaza), ni por la IA (el hook lo bloquea).
