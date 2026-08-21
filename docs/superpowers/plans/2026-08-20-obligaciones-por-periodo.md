# Obligaciones por período: cada mes es una hoja cerrada — Plan de implementación

> **Para workers agénticos:** SUB-SKILL REQUERIDA: `superpowers:subagent-driven-development` o
> `superpowers:executing-plans`. Los pasos usan checkboxes (`- [ ]`).

> **⚠️ NO COMMITEAR** (lo hace el owner con GitLens) y **⚠️ NO MIGRAR** (Claude crea el `.sql`; el
> owner corre `migrate deploy` + `generate`).

**Goal:** Que la vista de obligaciones muestre **un mes por vez**, navegable, sin arrastrar nada
automáticamente; que el owner marque en el mes de origen qué boletas pasan al siguiente; y que esos
traslados se ejecuten por tandas después de cerrar el período, con avance visible.

**Architecture:** El `overview` pasa a resolver por **mes calendario** en vez de por "período activo".
El traslado se parte en dos: una **marca** (`Invoice.carryOverRequestedAt`) que no mueve nada, y una
**ejecución por tandas** en un endpoint aparte que reusa `moveOneInvoiceToTarget`. El cierre de
período **no ejecuta traslados**: cerrar es irreversible y atómico, mover es lento y reintentable.

**Tech Stack:** Next.js 16, TypeScript, Prisma 6 + PostgreSQL, Vitest (proyectos `node` y `jsdom`).

**Spec:** `docs/superpowers/specs/2026-08-20-obligaciones-por-periodo-design.md`

---

## Contexto que el implementador necesita saber

**El incidente que lo originó.** El owner abrió `/admin/obligaciones` y encontró 31 boletas de marzo a
julio en un edificio **sin gastos fijos cargados**. El bloque "impagas de meses anteriores" listaba
toda boleta con `isPaid: false` de períodos cerrados — y como **los pagos se registran fuera de la
app**, eso era el histórico entero: 1124 de 1125 boletas.

**La app no sabe qué está pagado, y no tiene por qué.** Decisión del owner (2026-08-20). Consecuencia
para el implementador: **no se puede filtrar por "impaga"** en ningún lado. Qué pasa al mes siguiente
lo decide el owner con un botón.

**Por qué la marca y no el movimiento directo.** Al marcar, el período destino puede no existir: se
crea al cerrar. Y es al cerrar cuando el owner terminó de revisar el mes.

**Por qué tandas y no todo en el cierre.** Cada traslado toca Drive y Sheets (~2 s; el paso `move`
midió 1277 ms en un diagnóstico real). Con 46 edificios son ~1 min 30 s, y el túnel corta cada request
a los 100 s. El límite es **por request**, así que partiendo en tandas de 5 el total deja de tener
techo. **Secuencial, no en paralelo:** la cuota de Sheets es 60 escrituras/minuto.

**Convenciones:** PowerShell sin `&&`; tests puros `.test.ts` / UI `.test.tsx`; CSS Modules en modo
`pure` (`npm run build` lo detecta); toda acción async con `AsyncButton`; textos en castellano.

---

## Pasos

### 1. Migración — HECHO

- [x] `Invoice.carryOverRequestedAt DateTime?` en `schema.prisma`
- [x] `prisma/migrations/20260820000000_invoice_carry_over_requested/migration.sql`
- [x] Aplicada por el owner

### 2. Lógica pura — HECHO

- [x] `src/lib/periodMonth.ts`: navegación de meses, `parseMonthParam`, `majorityMonth` (10 tests)
- [x] `src/lib/carryOverBatch.ts`: tamaño de tanda y su validación en el server (7 tests)

### 3. Backend — HECHO

- [x] `overview` recibe `?month=&year=`; trae el período de ese mes **sin filtrar por estado** y
      devuelve `periodStatus`
- [x] Se elimina la consulta `unpaid` (la que traía las 1124). `carried` pasa a ser "boletas que viven
      en este período pero nacieron en otro"
- [x] `POST`/`DELETE` en `invoices/[id]/carry-over`: marcar y desmarcar. **No mueven**
- [x] `POST invoices/[id]/carry-over/undo`: devuelve al origen una YA trasladada, aunque el origen
      esté cerrado (faltaba; lo detectó la re-revisión)
- [x] `POST /api/client/obligations/carry-over`: mueve una tanda (máx. 5, secuencial)
- [x] `GET /api/client/obligations/carry-over/pending?month=&year=`: lo que falta mover
- [x] `executeCloseAll` **no** ejecuta traslados (se revirtió el intento con tope de 20)
- [x] Se sacó el chequeo de `isPaid` del traslado

### 4. UI — HECHO

- [x] Selector de mes con flechas en el encabezado
- [x] `sheetModel` refleja el payload nuevo (`periodStatus`, `carryOverRequested`, `carriedIn`)
- [x] Botón "Pasar al mes siguiente" en la fila del gasto fijo **que ya tiene boleta**
- [x] Bloque "Vienen del mes anterior" (sin la acción de traer, que ya no existe)
- [x] **Bucle de tandas** en `useCarryOverRun`, reusando `useBatchRunner` tal cual
- [x] **"Quedaron N sin pasar — continuar"** con barra de avance, en el tope de la vista
- [x] Botones de la arrastrada: volver a pasarla (encadenado) y devolverla a su mes de origen
      (faltaban; lo detectó la re-revisión)
- [ ] Mostrar en cada edificio si su período de ese mes está abierto o cerrado (el dato ya viaja en
      `periodStatus`; falta pintarlo)

### 5. PDF — HECHO

- [x] La sección aparte **ya existía** desde la Parte 2 (2026-08-12): sólo se renombró el título a
      "VIENEN DEL MES ANTERIOR". Buen recordatorio de inventariar antes de construir

### 6. Verificación

- [x] `npm run typecheck` · `npm run lint` (0 errores) · 768 tests · `build` · `build:jobs`
- [ ] Smoke del owner: marcar una boleta, cerrar el período, ver la barra avanzar y confirmar que la
      boleta aparece en el mes siguiente en el bloque "Vienen del mes anterior"

---

## Lo que encontró la re-revisión (por haber codeado sin plan)

1. **El arrastre encadenado se había perdido.** Una boleta que pasó de julio a agosto y en agosto
   tampoco se pagaba quedaba atrapada: el botón vivía sólo en las filas de gastos fijos, y una
   arrastrada nunca se vincula a una obligación en el destino (`obligation.service.ts` filtra
   `carriedFromPeriodId: null`). El modelo viejo sí lo soportaba.
2. **Faltaba el deshacer de un traslado ejecutado**, que el spec pedía — y el plan lo daba por hecho.
3. **Dead code**: `handleRunNow` quedó sin usar en el panel de clientes al reemplazar "Ejecutar ahora"
   por la corrida selectiva. Eliminado.

Los tres son del mismo tipo: **requisitos o comportamientos existentes que se perdieron al pasar del
diseño al código sin inventariarlos**.

## Trampas conocidas

**No poner los traslados dentro del cierre.** Se intentó y obligaba a un tope arbitrario (20) para no
comerse el timeout; peor, las que quedaban afuera eran **inalcanzables**, porque su período ya estaba
cerrado y un segundo cierre no las volvía a mirar. Queda escrito para que no se reintente.

**El registro repetido no es un sobrante.** Al filtrar filas de la hoja hay que seguir contándolas como
"presentes", o el reporte pide borrar lo que está bien. Mismo cuidado que en el sync de directorio.

**Tests que cambiaron de significado.** Las arrastradas se ordenaban por período de origen; ahora
**todas vienen del mes anterior**, así que ese orden dejó de significar algo y pasaron a alfabético por
concepto. Si un test viejo falla, revisar si el comportamiento cambió a propósito antes de "arreglarlo".
