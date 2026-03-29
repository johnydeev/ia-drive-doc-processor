# Manual de Usuario — Drive Doc Processor

Sistema de procesamiento automático de boletas y facturas para administración de consorcios.

---

## 1. ¿Qué hace el sistema?

Drive Doc Processor es una herramienta que **automatiza el procesamiento de boletas y facturas en formato PDF** para administradores de consorcios de propiedad horizontal.

El sistema:

- **Escanea automáticamente** una carpeta de Google Drive buscando PDFs nuevos.
- **Lee cada PDF** usando inteligencia artificial para extraer los datos clave: proveedor, monto, fecha de vencimiento, CUIT, número de cliente, etc.
- **Identifica automáticamente** a qué consorcio (edificio) y proveedor corresponde cada boleta.
- **Detecta duplicados** para evitar cargar la misma boleta dos veces.
- **Registra los datos** en una planilla de Google Sheets y en la base de datos del sistema.
- **Organiza los archivos** en carpetas de Drive según su estado (pendiente, escaneado, sin asignar).

El sistema reconoce boletas de servicios públicos (Edesur, Edenor, AySA, Metrogas, Naturgy, Camuzzi, Litoral Gas, Personal) y también facturas de proveedores comunes.

---

## 2. Acceso al sistema

1. Abrir el navegador e ingresar la dirección del sistema proporcionada por el administrador.
2. Introducir el **email** y **contraseña** asignados.
3. Hacer clic en **Iniciar sesión**.

La sesión dura 24 horas. Pasado ese tiempo, el sistema pedirá iniciar sesión nuevamente.

> **Roles de usuario:**
>
> | Rol | Permisos |
> |-----|----------|
> | **CLIENT** | Acceso completo al panel de su cuenta: ver boletas, sincronizar directorio, cerrar períodos, subir recibos |
> | **VIEWER** | Acceso de solo lectura al panel |
> | **ADMIN** | Acceso a la gestión de todos los clientes, métricas, configuración e invoices |

---

## 3. Panel principal

Al iniciar sesión se muestra el panel principal con las siguientes áreas:

### Sidebar (barra lateral)

La barra lateral se puede colapsar en escritorio (mostrando solo iconos) y se convierte en menú hamburguesa en tablets y celulares.

Contiene:

- **Nombre del cliente** — identifica la cuenta activa.
- **Sincronizar directorio** — importa consorcios, proveedores y servicios desde el archivo ALTA de Google Sheets.
- **Consorcios** — acceso a la gestión de consorcios (requiere suscripción Premium).
- **Cerrar Periodo General** — cierra el período contable activo de todos los consorcios (solo rol CLIENT).
- **Cerrar sesión** — finaliza la sesión actual.

### Toolbar superior

- **Pausar / Ejecutar scheduler** (izquierda) — permite detener o reanudar el procesamiento automático de boletas.
- **Tema claro / oscuro** (derecha) — switch con iconos de sol y luna para cambiar la apariencia visual.

> ✅ El tema seleccionado se mantiene durante la sesión pero no se guarda para futuras sesiones.

---

## 4. Configuración inicial — Cargar consorcios y proveedores

Antes de que el sistema pueda procesar boletas, es necesario cargar los datos de los consorcios (edificios) y proveedores. Esto se hace mediante un archivo de Google Sheets llamado **ALTA**.

### Pasos para la configuración inicial

1. Crear un archivo de Google Sheets en Google Drive.
2. Compartir el archivo con la cuenta de servicio del sistema (el administrador proporcionará el email).
3. Copiar el **ID del archivo** (se encuentra en la URL de Sheets, entre `/d/` y `/edit`).
4. Desde el panel de administración, editar la configuración del cliente y pegar el ID en el campo **"ID archivo ALTA"**.
5. Hacer clic en **"Sincronizar directorio"** desde el sidebar — el sistema creará automáticamente las hojas necesarias con sus encabezados.
6. Completar los datos en cada hoja y volver a sincronizar.

---

## 5. Archivo ALTA en Google Sheets

El archivo ALTA es la fuente principal de datos del sistema. Contiene 5 hojas:

### Hoja `_Consorcios`

Lista de edificios/consorcios administrados.

| Columna A | Columna B | Columna C | Columna D |
|-----------|-----------|-----------|-----------|
| NOMBRE CANÓNICO | CUIT | NOMBRES ALTERNATIVOS | ALIAS |

**Ejemplo:**

| NOMBRE CANÓNICO | CUIT | NOMBRES ALTERNATIVOS | ALIAS |
|-----------------|------|----------------------|-------|
| ALMIRANTE BROWN 706 | 30-52312872-4 | BROWN ALMTE AV 708\|ALMIRANTE BROWN 708 | ALM. BROWN |
| ARENALES 2154 | 30-71234567-8 | CONS PROP ARENALES\|ARENALES 56 | ARENALES |
| THAMES 647 | 30-65432198-0 | | THAMES |

- **Nombre canónico**: el nombre oficial del consorcio tal como se quiere ver en los reportes. Usar formato "CALLE NÚMERO" (ej: `ALMIRANTE BROWN 706`).
- **CUIT**: el CUIT del consorcio. Es el identificador principal para el matching automático.
- **Nombres alternativos**: variantes del nombre que pueden aparecer en las boletas, separadas por `|`. Campo interno, no se muestra en la interfaz.
- **Alias**: nombre corto visible en la interfaz y en la columna "ALIAS" de la planilla de datos.

### Hoja `_Proveedores`

Lista de proveedores que emiten facturas a los consorcios.

| Columna A | Columna B | Columna C | Columna D |
|-----------|-----------|-----------|-----------|
| NOMBRE CANÓNICO | CUIT | NOMBRES ALTERNATIVOS | ALIAS |

**Ejemplo:**

| NOMBRE CANÓNICO | CUIT | NOMBRES ALTERNATIVOS | ALIAS |
|-----------------|------|----------------------|-------|
| TIGRE ASCENSORES S.A. | 27-33906838-6 | TIGRE ASCENSORES | TIGRE |
| LIMPIEZA TOTAL S.R.L. | 30-71234567-9 | LIMP TOTAL | L. TOTAL |

- Misma estructura que `_Consorcios`.
- Incluir la razón social completa (S.A., S.R.L., etc.) en el nombre canónico.

### Hoja `_Rubros`

Categorías de gasto para clasificar las boletas.

| Columna A | Columna B |
|-----------|-----------|
| NOMBRE | DESCRIPCIÓN |

**Ejemplo:**

| NOMBRE | DESCRIPCIÓN |
|--------|-------------|
| Mantenimiento | Gastos de mantenimiento general |
| Servicios públicos | Luz, gas, agua |
| Seguros | Pólizas de seguro del edificio |

### Hoja `_Coeficientes`

Coeficientes de liquidación para distribuir gastos.

| Columna A | Columna B |
|-----------|-----------|
| NOMBRE | CÓDIGO |

**Ejemplo:**

| NOMBRE | CÓDIGO |
|--------|--------|
| Expensas ordinarias | A |
| Expensas extraordinarias | B |
| Fondo de reserva | C |

### Hoja `_LspServices`

Servicios de empresas públicas vinculados a cada consorcio. Permite que el sistema identifique a qué consorcio pertenece cada boleta de servicio público usando el número de cliente.

| Columna A | Columna B | Columna C | Columna D |
|-----------|-----------|-----------|-----------|
| NOMBRE CANÓNICO (consorcio) | PROVEEDOR | NRO CLIENTE | DESCRIPCIÓN |

**Ejemplo:**

| NOMBRE CANÓNICO | PROVEEDOR | NRO CLIENTE | DESCRIPCIÓN |
|-----------------|-----------|-------------|-------------|
| ALMIRANTE BROWN 706 | EDESUR | 366037 | Edificio |
| ALMIRANTE BROWN 706 | AYSA | 128456 | |
| ARENALES 2154 | EDESUR | 891234 | Local comercial |
| ARENALES 2154 | METROGAS | 445566 | |

- **Nombre canónico**: debe coincidir exactamente con el nombre del consorcio en la hoja `_Consorcios`.
- **Proveedor**: nombre normalizado de la empresa. Valores aceptados: `EDESUR`, `EDENOR`, `AYSA`, `METROGAS`, `NATURGY`, `CAMUZZI`, `LITORAL_GAS`, `PERSONAL`.
- **Nro cliente**: el número de cuenta/cliente en esa empresa (sin ceros a la izquierda).
- **Descripción**: opcional, para diferenciar cuando un consorcio tiene varios servicios del mismo proveedor.

> ⚠️ **Sin esta hoja cargada, las boletas de servicios públicos no podrán vincularse automáticamente a un consorcio específico.** El sistema necesita el número de cliente para hacer la asociación.

---

## 6. Sincronizar directorio

La sincronización importa los datos del archivo ALTA de Google Sheets a la base de datos del sistema.

### Cuándo sincronizar

- **Después de la carga inicial** de datos en el archivo ALTA.
- **Cada vez que se modifique** el archivo ALTA (agregar, editar o eliminar consorcios, proveedores, rubros, coeficientes o servicios LSP).

### Cómo sincronizar

1. Hacer clic en **"Sincronizar directorio"** en el sidebar.
2. Esperar a que el proceso termine (puede tardar unos segundos).
3. El sistema mostrará un resumen de los cambios aplicados.

### Comportamiento de la sincronización

| Entidad | Estrategia |
|---------|------------|
| Consorcios | Crea los nuevos, actualiza los existentes. Intenta eliminar los que ya no están en Sheets (si no tienen boletas asociadas). |
| Proveedores | Igual que consorcios. |
| Rubros | Reemplazo total: borra todos y recrea desde Sheets. |
| Coeficientes | Reemplazo total. |
| LspServices | Reemplazo total. |

> ⚠️ **Sincronizar siempre después de cada cambio en el archivo ALTA.** Si se agregan consorcios o proveedores en Sheets pero no se sincroniza, el sistema no los reconocerá al procesar boletas.

> ✅ Los consorcios nuevos reciben automáticamente un período activo al sincronizar, por lo que están listos para recibir boletas inmediatamente.

---

## 7. Procesamiento automático de boletas

### Cómo funciona

El sistema ejecuta un ciclo automático que:

1. Escanea la carpeta **Pendientes** de Google Drive buscando archivos PDF nuevos.
2. Descarga cada PDF y lo analiza con inteligencia artificial.
3. Identifica el consorcio y proveedor correspondientes.
4. Registra los datos en la planilla de Google Sheets y en la base de datos.
5. Mueve el archivo a la carpeta **Escaneados** (si se asignó correctamente) o **Sin Asignar** (si no pudo identificar el destino).

### Carpetas de Google Drive

| Carpeta | Función |
|---------|---------|
| **Pendientes** | Donde se colocan los PDFs nuevos para procesar. |
| **Escaneados** | PDFs procesados y asignados correctamente. |
| **Sin Asignar** | PDFs que el sistema no pudo vincular a un consorcio o proveedor. |
| **Fallidos** | PDFs que generaron un error técnico durante el procesamiento. |
| **Recibos** | Recibos de pago subidos manualmente desde la interfaz. |

### Tipos de boletas aceptadas

- **Facturas de proveedores**: facturas tipo A, B, C, tickets, recibos de cualquier proveedor.
- **Boletas de servicios públicos**: Edesur, Edenor, AySA, Metrogas, Naturgy, Camuzzi, Litoral Gas, Personal.

> ⚠️ **Solo se aceptan archivos PDF con texto digital.** Los PDFs que son imágenes escaneadas sin texto seleccionable tendrán menor precisión en la extracción. Para mejores resultados, usar los PDFs originales descargados desde el sitio del proveedor.

### Detección de duplicados

El sistema detecta duplicados de dos formas:

1. **Por hash del archivo**: si el mismo PDF exacto ya fue procesado anteriormente.
2. **Por datos de la boleta**: si otra boleta tiene el mismo número, CUIT del proveedor, fecha de vencimiento y monto.

Las boletas duplicadas se marcan pero igualmente se registran en la planilla de Sheets con la columna "ES_DUPLICADO" en `true`.

### Datos registrados en Google Sheets

Cada boleta procesada genera una fila con las siguientes columnas:

| Columna | Dato |
|---------|------|
| A | Número de boleta |
| B | Proveedor |
| C | Consorcio |
| D | CUIT del proveedor |
| E | Detalle |
| F | Observación |
| G | Fecha de vencimiento |
| H | Monto (formato: $ 118.000,00) |
| I | Alias |
| J | Número de cliente |
| K | URL del archivo en Drive |
| L | ¿Es duplicado? |
| M | Período (formato: MM/YYYY) |

---

## 8. Boletas sin asignar

Cuando el sistema no puede determinar a qué consorcio o proveedor corresponde una boleta, la mueve a la carpeta **Sin Asignar** en Google Drive.

### Causas comunes

- **El consorcio no está cargado** en el archivo ALTA o no se sincronizó después de agregarlo.
- **El proveedor no está cargado** en el archivo ALTA.
- **El CUIT no coincide** con ningún consorcio o proveedor registrado.
- **El nombre en la boleta es muy diferente** al nombre canónico y no hay nombres alternativos configurados.
- **Falta el servicio LSP**: para boletas de servicios públicos, el número de cliente no está registrado en la hoja `_LspServices`.

### Procedimiento para resolver boletas sin asignar

1. **Revisar la boleta** en la carpeta Sin Asignar de Drive para identificar a qué consorcio y proveedor pertenece.
2. **Verificar** que el consorcio y proveedor estén cargados en el archivo ALTA con los datos correctos (nombre, CUIT).
3. **Si el nombre no matchea**: agregar el nombre que aparece en la boleta como **nombre alternativo** en la columna C de la hoja correspondiente (`_Consorcios` o `_Proveedores`), separado por `|`.
4. **Si es una boleta de servicio público**: verificar que el servicio esté registrado en la hoja `_LspServices` con el número de cliente correcto.
5. **Sincronizar directorio** desde el panel.
6. **Mover la boleta** de la carpeta Sin Asignar a la carpeta Pendientes para que se reprocese.

> ⚠️ **No borrar los archivos de la carpeta Sin Asignar.** Moverlos a Pendientes para que el sistema los reprocese con los datos corregidos.

---

## 9. Cerrar período general

El cierre de período contable se realiza para todos los consorcios simultáneamente.

### Pasos

1. Hacer clic en **"Cerrar Periodo General"** en el sidebar.
2. Se abre un modal con el **paso 1 (preview)**:
   - Muestra el mes que se va a cerrar (el mes mayoritario entre los períodos activos).
   - Lista los consorcios que se cerrarán y los que se saltearán (con el motivo).
3. Confirmar para ejecutar el cierre (**paso 2**).
4. El sistema:
   - Cambia el estado del período activo a **CERRADO** en cada consorcio.
   - Crea un nuevo período **ACTIVO** para el mes siguiente.
5. Se muestra el resultado con los contadores: cerrados, creados, salteados.

> ✅ Esta función solo está disponible para usuarios con rol **CLIENT**.

> ✅ El cierre no borra ninguna boleta ni dato. Solo cambia el período contable activo.

---

## 10. Recibos de pago

El sistema permite adjuntar un recibo de pago a cada boleta procesada.

### Cómo subir un recibo

1. Ir a la sección de **Consorcios** (requiere suscripción Premium).
2. Seleccionar el consorcio correspondiente.
3. Buscar la boleta a la que se quiere adjuntar el recibo.
4. Hacer clic en el botón de subir recibo.
5. Seleccionar el archivo PDF del recibo.

El recibo se guarda en Google Drive organizado por consorcio y mes:

```
📁 Recibos
  └── 📁 ALMIRANTE BROWN 706
        └── 📁 Marzo 2026
              └── recibo.pdf
```

---

## 11. Avisos importantes

### El CUIT es el identificador principal

> ⚠️ El sistema utiliza el **CUIT como identificador principal** para vincular boletas con consorcios y proveedores. Asegurarse de que los CUITs estén correctamente cargados en el archivo ALTA. Un CUIT incorrecto hará que las boletas no se asignen.

### Sincronizar después de cada cambio

> ⚠️ **Cada vez que se modifique el archivo ALTA** (agregar, editar o eliminar datos), es necesario hacer clic en "Sincronizar directorio" desde el panel. Sin la sincronización, los cambios no tendrán efecto.

### No borrar archivos de Sin Asignar

> ⚠️ Los archivos en la carpeta Sin Asignar deben **moverse a Pendientes** (no borrarse) para que el sistema los reprocese. Si se borran, se pierden definitivamente.

### Servicios públicos requieren _LspServices

> ⚠️ Para que las boletas de servicios públicos (Edesur, AySA, Metrogas, etc.) se asignen correctamente, es **obligatorio** cargar la hoja `_LspServices` en el archivo ALTA con el número de cliente de cada servicio por consorcio.

### Nombres alternativos (matchNames)

> ✅ Si una boleta aparece en Sin Asignar porque el nombre del consorcio o proveedor en el PDF es diferente al registrado, se puede agregar ese nombre como **nombre alternativo** en la columna C del archivo ALTA (separado por `|`). Ejemplos:
>
> - El consorcio está como `ALMIRANTE BROWN 706` pero la boleta dice `BROWN ALMTE AV 708` → agregar `BROWN ALMTE AV 708` como nombre alternativo.
> - El proveedor está como `TIGRE ASCENSORES S.A.` pero la boleta dice `TIGRE ASCENSORES` → agregar `TIGRE ASCENSORES` como nombre alternativo.

### Solo PDFs con texto digital

> ⚠️ El sistema funciona mejor con **PDFs que contienen texto digital** (seleccionable). Los PDFs que son solo imágenes escaneadas pueden procesarse pero con menor precisión. Para mejores resultados, descargar las boletas directamente desde el sitio web del proveedor o la empresa de servicios.

### Pausar el scheduler para cambios masivos

> ✅ Si se van a hacer cambios importantes en el archivo ALTA (agregar muchos consorcios, proveedores o servicios), es recomendable **pausar el scheduler** desde la toolbar superior antes de hacer los cambios. Una vez terminada la edición y sincronizada, reanudar el scheduler. Esto evita que se procesen boletas mientras los datos están incompletos.

### Tamaño de lote

> ✅ El sistema procesa los PDFs en lotes. El **tamaño de lote** (cantidad de PDFs procesados por ciclo) es configurable por el administrador. Si hay muchos PDFs pendientes, se procesarán en varios ciclos sucesivos. Esto es normal y no requiere acción del usuario.
