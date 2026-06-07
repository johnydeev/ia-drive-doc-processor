# Spec — Rendiciones por edificio (statements)

Fecha: 2026-06-05
Estado: Aprobado (diseño). Pendiente de plan de implementación.

---

## 1. Objetivo

Organizar automáticamente cada boleta y comprobante de pago en una estructura
de carpetas en Drive pensada para **rendir cuentas a los inquilinos** de cada
consorcio. Cada edificio tiene una carpeta pública (compartida con link, lector)
cuyo **QR se genera una sola vez**; dentro, los períodos se van agregando mes a
mes, creando un historial navegable.

**Propósito de negocio:** el inquilino escanea el QR de su edificio y ve, por
período, los gastos (boletas) y los comprobantes de pago (recibos) — seguimiento
de **qué se pagó y cuándo**.

---

## 2. Decisiones de diseño (cerradas)

| Tema | Decisión |
|---|---|
| Estructura | Árbol invertido: `[raíz statements] / [Edificio] / [Período] /` |
| Acceso | Carpeta del edificio compartida **pública (anyone, reader)** por la app, una vez |
| Link QR | Guardado en la DB (`Consortium.statementsFolderUrl`), visible en el panel. El QR lo genera el usuario |
| Alcance | Pipeline **y** carga manual. Boletas nuevas en adelante (no se migran históricas) |
| Contenido | Boletas **+** recibos de pago en la misma carpeta de período |
| Duplicación | **Un solo archivo** en statements; NO se copia en Escaneados |
| Raíz `statements` | La crea el usuario una vez; su ID va en `driveFoldersJson.statements` |
| Subcarpetas | Edificio y Período las crea la app (`getOrCreateFolder`) |

### Nombre del campo
Se usa `statements` (término contable correcto para "rendición de cuentas").
- `driveFoldersJson.statements` → ID de la carpeta raíz.
- `Consortium.statementsFolderId` / `Consortium.statementsFolderUrl`.

---

## 3. Estructura en Drive

```
Unidad Compartida "Control de Boletas y Pagos"
├── PAGOS DEL MES/              ← INTERNO (privado)
│   ├── Pendientes
│   ├── Escaneados             ← histórico de boletas viejas; deja de recibir nuevas
│   ├── Sin Asignar
│   └── Duplicados
└── Rendiciones/                ← PÚBLICO (raíz statements, la crea el usuario)
      └── JUNIN 1222/           ← carpeta del edificio (compartida 1 vez; QR apunta acá)
            ├── 2026-06 Junio/
            │     ├── MATAFUEGOS GOMEZ - JUNIN 1222 - P06-2026 - 0005-00009460.pdf
            │     └── MATAFUEGOS GOMEZ - JUNIN 1222 - P06-2026 - 0005-00009460 - RECIBO 15-06-2026.pdf
            └── 2026-07 Julio/
```

- **Nombre de la carpeta del edificio:** `consortium.rawName` (el nombre real
  registrado, legible para el inquilino). Mismo valor que se usa como "Consorcio"
  en el nombre de los archivos, para consistencia.
- **Carpeta de período:** `YYYY-MM Mes` (ej. `2026-06 Junio`) → ordena
  cronológicamente y es legible.
- Solo la carpeta del **edificio** se comparte pública. Los períodos heredan el
  acceso (al estar dentro).

---

## 4. Modelo de datos

Migración: agregar a `Consortium`:
- `statementsFolderId String?`
- `statementsFolderUrl String?`

Se llenan la primera vez que la app crea/comparte la carpeta del edificio; luego
se reutilizan (no se vuelve a crear ni a compartir).

`ClientDriveFolders` (tipo) y `ResolvedFolders` + `resolveFolders`: agregar
`statements: string | null` (desde `driveFoldersJson.statements`).

---

## 5. Helpers y servicios

### Funciones puras (naming, sanitizadas)
Caracteres inválidos a remover/reemplazar: `/ \ : * ? " < > |`.

- `buildStatementPeriodFolderName(month, year)` → `"2026-06 Junio"`.
- `buildInvoiceFileName({ provider, consortium, month, year, boletaNumber, documentHash })`
  → `"PROVEEDOR - CONSORCIO - P06-2026 - NNNN.pdf"`.
  - **Sin N° de boleta** (la IA no lo extrajo): se usa `SN` + los primeros 6
    caracteres del `documentHash` para garantizar unicidad →
    `"PROVEEDOR - CONSORCIO - P06-2026 - SN a3f9c2.pdf"`.
- `buildReceiptFileName({ provider, consortium, month, year, boletaNumber, paymentDate, amount, installmentNumber, totalInstallments })`
  → según el tipo de pago:
  - **Pago único** (salda el total): `"... - NNNN - RECIBO 15-06-2026.pdf"`.
  - **Cuotas pactadas** (`totalInstallments > 1`):
    `"... - NNNN - RECIBO cuota 1 de 3 - 15-06-2026.pdf"`.
  - **Pago parcial libre** (no salda el total, sin cuotas): incluye el monto
    para distinguir parciales del mismo día →
    `"... - NNNN - RECIBO pago parcial - 15-06-2026 - $250000.pdf"`.

### `GoogleDriveService`
- `renameFile(fileId, newName)` → `files.update({ name })` (con `supportsAllDrives`).
- `shareFolderPublic(folderId)` → `permissions.create({ type: "anyone", role: "reader" })`;
  retorna el `webViewLink` de la carpeta. Idempotente en la práctica (solo se
  llama al crear la carpeta del edificio).

### Orquestador
- `resolveStatementsFolders(prisma, client, consortium, period)`:
  1. Toma la raíz `folders.statements`.
  2. `getOrCreateFolder(edificio, raíz)`. Si la carpeta del edificio es **nueva**:
     `shareFolderPublic` + guardar `statementsFolderId`/`statementsFolderUrl` en
     `Consortium`. Si ya existía (id en DB), reutiliza.
  3. `getOrCreateFolder(período, edificio)`.
  4. Retorna `{ buildingFolderId, periodFolderId }`.
  - **Cache en memoria por ciclo** (worker) para no repetir llamadas a Drive por
    cada boleta del mismo edificio/período.

---

## 6. Cambios en los flujos

### 6.0 Validaciones preventivas en el SCHEDULER (la "llave", antes de gastar tokens)
**Clave para no quemar tokens IA.** El scheduler corre cada N min y encola
boletas; el worker es el único que consume IA. Por eso la validación se hace en
el scheduler **antes de encolar** — si falla, no se encola nada → **cero tokens**.

Antes de encolar las boletas de un cliente, el scheduler valida **a nivel
cliente**:
1. **Carpetas requeridas configuradas** (incluida `statements`). Se extiende
   `validateClientProcessingConfig` para incluir `statements`.
2. **Que exista al menos un período ACTIVE** en el cliente.

Si **cualquiera** falla → el scheduler **NO encola** ese cliente en ese ciclo,
**loguea un aviso claro** y los PDFs quedan en Pendientes. Al corregir el
problema (configurar la carpeta / abrir período), el **próximo ciclo** procesa
normal. No se gasta ningún token porque el worker nunca recibe los jobs.

> Por qué el período se valida así: el período es por consorcio y el consorcio
> sólo se conoce tras la extracción IA. Pero como los períodos se manejan en
> conjunto ("Cerrar Período General" abre el período de todos los consorcios),
> en la práctica es todo-o-nada — la validación a nivel cliente cubre el peor
> caso (ningún período → corta todo).

### 6.1 Pipeline / worker (`processPendingDocuments.job.ts`)
Cuando la boleta es **OK y NO duplicada** (reemplaza el paso "Mover a Escaneados"):
1. `resolveStatementsFolders` → carpetas edificio/período (+ compartir si nuevo).
2. `renameFile` con `buildInvoiceFileName`.
3. `moveFileToFolder(fileId, origen, periodFolderId)`.
4. `sourceFileUrl` = link del archivo en su nueva ubicación.

Duplicado → carpeta Duplicados (sin cambios). Sin asignar → Sin Asignar (sin cambios).

**Red de seguridad (caso puntual):** si el scheduler dejó pasar el cliente
(hay períodos activos) pero **un consorcio específico** no tiene período al
matchearse, el worker mueve esa boleta a **Revisión** (`failed`) + aviso en
logs. Es una sola boleta — el gasto masivo ya lo cortó la llave del scheduler.

### 6.2 Carga manual (`POST /api/client/consortiums/[id]/invoices`)
El PDF se sube directo a la carpeta de período de statements (hoy va a Escaneados),
con el nombre de `buildInvoiceFileName`. Reusa `resolveStatementsFolders`.

### 6.3 Recibos (`POST .../invoices/[invoiceId]/receipt`)
El comprobante se sube a la **misma** carpeta `statements/[Edificio]/[Período]`
(hoy va a `receipts/Consorcio/Período`), con `buildReceiptFileName`. El período
es el de la invoice asociada.

---

## 7. Panel
En `/admin/consortiums`, por cada consorcio mostrar `statementsFolderUrl` (si
existe) con botón **Copiar** para generar el QR. Si está vacío (todavía no se
procesó ninguna boleta de ese edificio), mostrar un guion o "Pendiente".

---

## 8. Ajustes a funcionalidad existente
- **Eliminar boleta**: el archivo ahora vive en `statements/[Edificio]/[Período]`
  (antes en Escaneados). El borrado debe moverlo a **Revisión** (`failed`) —
  destino sin cambios — tomándolo **desde su parent real** vía `getFileParents`
  (cambia el origen, no el destino). Confirmado: al eliminar, el PDF va a
  Revisión (`failed`).
- **Purga**: ídem — mover desde el parent real (Rendiciones) en vez de asumir
  Escaneados.
- **Escaneados**: queda como histórico de boletas viejas; lo ya guardado no se
  toca. Deja de recibir boletas nuevas.

---

## 9. Notas operativas y edge cases
- **Sharing externo:** la Unidad Compartida debe permitir "compartir fuera de la
  organización" para que el link público funcione (config de la unidad, una vez).
- **Sanitización:** nombres de proveedor/consorcio con caracteres inválidos para
  Drive deben limpiarse en los helpers de naming.
- **Colisiones de archivo:** boleta → N° de boleta, o `SN + 6 del hash` si no hay
  N°. Recibo → fecha de pago + nº de cuota (cuotas) o + monto (parcial libre).
- **Performance:** cache en memoria de folderIds por ciclo del worker.
- **Idempotencia:** `getOrCreateFolder` evita carpetas duplicadas; el sharing y el
  guardado del link solo ocurren la primera vez por edificio.
- **Sin período — peor caso:** lo corta la **llave del scheduler** (sección 6.0):
  si el cliente no tiene ningún período ACTIVE, no se encola nada → 0 tokens.
- **Sin período — caso puntual:** un consorcio específico sin período (con el
  resto del cliente con período) → la boleta va a **Revisión** (`failed`) +
  aviso (sección 6.1).
- **Consorcio nuevo:** al darse de alta (UI / import / sync-directory) toma el
  período vía `resolveMajorityMonth` = el **mes mayoritario** de los períodos
  ACTIVE del cliente. Tras un cierre general, todos están en el mismo mes, así
  que el nuevo **se alinea solo** y nace con período → la feature lo organiza
  desde su primera boleta (no cae en "sin período"). Si no hubiera ningún
  período activo, toma el mes del calendario (pero ese escenario lo corta la
  llave del scheduler).

---

## 10. Plan de testing (alto nivel)
- Unit: helpers de naming:
  - boleta con N°, sin N° (`SN + hash`), con caracteres especiales.
  - recibo: pago único, cuotas, pago parcial libre (con monto).
  - `buildStatementPeriodFolderName` (orden cronológico).
- Integración (manual en staging/prod controlado):
  - Pipeline: boleta OK → aparece renombrada en `statements/Edificio/Período`,
    carpeta del edificio compartida, link guardado en DB.
  - Carga manual: ídem.
  - Recibo (único / cuota / parcial libre): aparece junto a su boleta, naming OK.
  - Duplicado → carpeta Duplicados (no a statements).
  - **Llave scheduler:** sin `statements` configurada o sin período activo →
    NO encola + aviso en logs + PDFs quedan en Pendientes (0 tokens).
  - **Caso puntual:** consorcio sin período (resto con período) → boleta a
    Revisión (`failed`) + aviso.
  - **Consorcio nuevo:** alta tras cierre general → nace con el período en curso;
    su primera boleta se organiza en `statements/[Nuevo]/[Período]`.
  - Eliminar boleta: mueve desde statements → Revisión (`failed`) sin error.

---

## 11. Fuera de alcance (futuro)
- Generación del QR dentro de la app.
- Migración de boletas históricas a la nueva estructura.
- Permisos restringidos (no público) por edificio.
- Índice/portada por período (ej. una planilla resumen dentro de la carpeta).
