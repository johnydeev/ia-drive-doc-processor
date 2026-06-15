# Spec — Robustez del worker ante cortes del pooler de Supabase (P1017)

Fecha: 2026-06-14
Estado: Propuesto (diseño). Pendiente de revisión del owner + plan de implementación.

---

## 1. Objetivo

Que un **hipo transitorio de conexión a la DB** no deje jobs en estado zombie ni dispare
reprocesos que gastan cuota de IA. Concretamente: reintentar de forma **acotada** las
operaciones de DB del **worker** ante errores de conexión transitorios (P1017 y afines),
antes de rendirse.

No se busca eliminar la causa externa (el pooler de Supabase cierra conexiones), sino que
el worker la **absorba** sin dejar daño.

---

## 2. Contexto y caso testigo

La DB (Supabase) se accede vía el **pooler** (PgBouncer,
`…pooler.supabase.com:6543`). El pooler cierra conexiones idle y, además, tiene eventos
propios (reinicios/mantenimiento) que cierran conexiones de golpe → Prisma lanza
**`P1017 "Server has closed the connection"`**.

Lo ya hecho (entrada `docs/decisiones.md` del 2026-06-11):
- `claimNextJob()` está blindado con try/catch + sleep en
  [jobWorkerMain.ts:251](../../../src/jobs/jobWorkerMain.ts) → un P1017 al reclamar un job
  no crashea el worker; espera y reintenta al próximo poll (Prisma reconecta sola).
- Config de Prisma ([prisma.ts:76](../../../src/lib/prisma.ts)) ya fija para el pooler
  `pgbouncer=true`, `connection_limit=3`, `pool_timeout=30`.
- El **scheduler** ([scheduler.ts:70](../../../src/jobs/scheduler.ts)) ya es resiliente:
  try/catch **por cliente**, corre en intervalos y es **idempotente** (no deja estado a
  medias). Un P1017 solo saltea un cliente y reintenta al próximo ciclo.

Caso testigo (prod, 11/06): los cortes del pooler afectaron a web+worker+scheduler en el
mismo minuto (evento del lado de Supabase). El worker tenía 2 jobs `PROCESSING` zombie de
mayo que el reaper del scheduler recuperó. El blindaje del 11/06 cubrió **solo**
`claimNextJob`.

**El hueco que queda (foco de este spec):** las queries DENTRO de `handleJob` —en especial
`finalizeJob`— **no tienen retry**. Si un P1017 pega ahí:
- El job ya está `PROCESSING` (claimed) y el catch de `runWorker` solo loguea →
  **queda zombie** hasta que el reaper del scheduler lo recupera (>30 min).
- Peor caso: el P1017 pega en `finalizeJob` **después** de procesar la boleta OK → el job
  queda PROCESSING aunque la boleta ya se cargó → el reaper lo vuelve a PENDING →
  **reproceso que gasta cuota IA** (recurso escaso con el free tier). La dedup evita
  duplicar en DB/Sheets, pero el costo de tokens y la latencia quedan.

---

## 3. Decisiones de diseño (cerradas)

| Tema | Decisión |
|---|---|
| **Estrategia** | **Retry acotado reactivo**, espejando el patrón ya probado `callWithRetry` de [aiErrors.ts](../../../src/lib/aiErrors.ts) (que hace lo mismo para 429). Mismo estilo de `RetryOptions` + `sleep` inyectable. |
| **Matcher** | **Nuevo** `isTransientDbError`, acotado a conexión transitoria. **NO** se reusa `isPrismaConnectionError` ([prisma.ts:46](../../../src/lib/prisma.ts)) porque es demasiado amplio (matchea `"database"`, `"does not exist"`, P2021/P2022 de schema) → reintentar esos errores es inútil y lento. |
| **Qué reconoce** | `p1017`, `p1001`, `"server has closed the connection"`, `"connection closed"`, `"connection terminated"`, `"econnreset"`, y pool-timeout (`"timed out fetching"` / `"connection pool"`). **No** matchea unique/constraint/validación/negocio. |
| **Alcance** | Solo el **worker** (camino crítico `claim → finalize → client lookup`). El scheduler queda intacto (ya resiliente). |
| **Punto crítico** | `finalizeJob` — garantizar que el job quede `COMPLETED`/`PENDING` aunque haya un hipo, cerrando la ventana de zombie. Es lo más importante del cambio. |
| **Backoff** | 3 reintentos, ~500 ms entre intentos (transitorio de pooler se recupera rápido), `sleep` inyectable para tests. Al **agotar** los reintentos, relanza el **error original** (no lo envuelve en una clase nueva) → el caller lo maneja como hoy. |
| **Logging** | Nuevo `workerLog.dbRetry(op, attempt, error)` (espeja el estilo de `unhandledError`) para que los reintentos sean visibles en los logs exportados y se pueda medir la frecuencia real de P1017. |

---

## 4. Alternativas descartadas

- **Keep-alive proactivo** (un `SELECT 1` periódico para que la conexión no quede idle):
  YAGNI por ahora. El worker ya hace polling cada 2 s; el idle real ocurre durante jobs
  largos (descarga+OCR+IA), y el retry reactivo cubre ese caso sin agregar un timer. Se
  reconsidera si, tras el deploy, los logs muestran P1017 frecuente pese al retry.
- **`DIRECT_URL` (conexión directa, sin pooler) para el worker:** evita el pooler, pero
  Supabase limita las conexiones directas (pensadas para migraciones, no para procesos
  permanentes) y **no** cubre los eventos del lado de la DB. Mayor riesgo que beneficio.
- **Reusar `isPrismaConnectionError`:** descartado (ver tabla §3, fila Matcher).

---

## 5. Componentes (qué tocará la implementación)

> Descripción, sin código. El detalle fino va al plan de implementación (TDD).

- **Nuevo `src/lib/dbRetry.ts`**
  - `isTransientDbError(error: unknown): boolean` — matcher acotado (§3).
  - `withDbRetry<T>(fn, options): Promise<T>` — reintenta solo si `isTransientDbError`;
    propaga de inmediato cualquier otro error; al agotar reintentos relanza el original.
    `options`: `retries` (3), `backoffMs` (500), `onRetry?(attempt, error)`, `sleep?`.
- **Nuevo `src/lib/dbRetry.test.ts`** (TDD, espeja `aiErrors.test.ts`):
  - `isTransientDbError`: true para P1017 / "server has closed the connection"; false para
    P2002 (unique) y errores de negocio.
  - `withDbRetry`: reintenta y cede si el transitorio se recupera; propaga sin reintentar un
    error normal; agota N intentos y relanza el original. `sleep` fake (sin esperas reales).
- **`src/jobs/jobWorkerMain.ts`** — envolver con `withDbRetry` las operaciones de control
  del camino crítico: `claimNextJob` (findFirst + updateMany), `client.findUnique` en
  `handleJob`, y **`finalizeJob`** (los `processingJob.update`). El `onRetry` loguea con
  `workerLog.dbRetry`. La lógica de negocio del pipeline (`processSingleDriveFileJob`) NO se
  envuelve (ya maneja sus propios errores). `schedulerState.updateMany` y
  `persistence.recordClientRun` ya tienen try/catch no-crítico → se evalúa envolverlos solo
  si es trivial.
- **`src/lib/logger.ts`** — agregar `workerLog.dbRetry(op, attempt, error)`.

---

## 6. Verificación (de la futura implementación)

1. **TDD**: `npx vitest run src/lib/dbRetry.test.ts` — RED antes, GREEN después.
2. **Suite completa**: `npx vitest run` (100 actuales + nuevos, todo verde).
3. `npm run typecheck` + `npm run lint` (0 errores nuevos) + `npm run build:jobs`.
4. No se puede forzar un P1017 real local → los unit tests del helper cubren la lógica;
   typecheck/build confirman la integración en el worker. Opcional: test que envuelva una fn
   que falla 2× con P1017 y luego pasa.
5. **Docs** (obligatorio CLAUDE.md): entrada en `docs/decisiones.md`, avance del pendiente 2
   en `docs/progreso.md`, y `CHANGELOG.md`.

---

## 7. Fuera de alcance / notas

- **Scheduler**: no se toca (ya resiliente). Envolver sus queries con `withDbRetry` sería
  una mejora opcional futura (reduciría saltos de un ciclo ante un hipo), de bajo riesgo.
- **Sin migración de DB.**
- **Deploy**: push (CI) + rebuild del worker (lo hace el owner).
