# Changelog

## [Unreleased]

### Verified
- **Guard del vencimiento del CAE, primera verificación en producción (2026-08-30)**. Se reprocesaron
  `00002-00208625` y `00002-00208626` (ROMERO MIGUEL A → EVA PERON 1761, período 08/2026, mismo monto
  y números consecutivos): las dos entraron con `dueDate = null`, o sea el guard descarta la "Fecha de
  Vto. de CAE" que antes se guardaba como vencimiento de pago. La misma corrida confirma además el
  **matching por CUIT** de facturas comunes (entraron sin pasar por Sin Asignar) y que dos boletas
  hermanas con el mismo monto y el mismo edificio **no se deduplican** entre sí.

### Fixed
- **El LSD matcheaba el edificio por casualidad (2026-09-06)**. Con el prompt ya corregido, la
  segunda corrida dio 4 de 5: ALMIRANTE BROWN rebotó con `consortium_not_found` pese a tener la
  extracción perfecta (2 empleados, netos exactos, CUIT del edificio). `matchConsortium` mira
  `allTaxIds`/`consortium` y el prompt del libro no pide ninguno de los dos — el CUIT viaja en
  `lsd.consortiumTaxId`. El edificio se resolvía sólo si el modelo rellenaba `consortium` por su
  cuenta (4 de 5 libros). Ahora `cuitSanitizeStep` inyecta ese CUIT en `allTaxIds`.
  - Se prefirió eso a extender el barrido de CUITs del texto al LSD, que sumaría los CUIL de los
    empleados y de sus cargas de familia.
  - El fixture de `lsdContext` sembraba `allTaxIds`, un campo que el modelo real devuelve `null`;
    alineado con la salida medida, los 5 tests de LSD fallaban. Suite 901 → 902.
- **El LSD nunca recibía su prompt (2026-09-06)**. Primera prueba real: los 5 libros fueron a Sin
  Asignar con `lsd_sin_empleados`. El router los detectaba bien (`Tipo documento: LSP — LSD`) pero
  `buildExtractionPrompt` corría `isReciboHaberes` **antes** de `identifyLSPProvider`, y su regla
  `SUELDO && CUIL` la cumple todo libro de sueldos → se llevaba el prompt del recibo **individual**
  y la IA devolvía una boleta con el primer empleado y `lsd: null`. Ahora el router corre primero y
  el LSD queda exceptuado; `isReciboHaberes` conserva su precedencia sobre el resto (un recibo
  individual nombra el convenio de la federación y caería en el prompt sindical).
  - **El test existía y pasaba**: su fixture estaba recortado al encabezado y no contenía la palabra
    "SUELDO", justo la que dispara el falso positivo. Ahora lleva la fila real de un empleado con
    `Sueldo Basico` y `Total Neto`. Suite 899 → 901.
- **El vencimiento se mostraba un día antes en Boletas entrantes (2026-08-29)**. `formatDateOnly` de
  `/admin/boletas` formateaba el `dueDate` —una fecha de calendario, guardada a medianoche UTC— en la
  zona horaria del navegador. En Argentina (UTC-3) la medianoche del 7 es las 21:00 del 6, así que la
  tabla mostraba el día anterior en **todas** las boletas; en un vencimiento del primero de mes el
  error cambiaba hasta el mes (`2026-09-01` se veía `31/8/26`). Se agregó `timeZone: "UTC"`, igual
  que en la vista de consorcios, que ya lo tenía. `createdAt` sigue formateándose en hora local, que
  es lo correcto para un instante real. Los helpers pasaron de `page.tsx` a
  `boletas/lib/format.ts` con 7 tests que fuerzan `TZ=America/Argentina/Buenos_Aires` — sin eso el
  caso pasa en verde en un runner en UTC y no prueba nada. **El dato guardado siempre estuvo bien**:
  no hay que corregir boletas. Suite 822 → 829.

### Added
- **El VEP de ARCA se registra como gasto (2026-09-03)**. Los VEP con los que cada consorcio paga
  las cargas sociales de su encargado se descartaban desde el 2026-08-31 (triage capa 0). Ahora
  entran imputados al edificio del CUIT del contribuyente, con proveedor **ARCA**.
  - **`buildVepPrompt`** propio (`src/lib/vepExtraction.ts`): un VEP es un cupón simple, mientras
    que `buildArcaPrompt` está escrito para la declaración jurada F931 de dos páginas.
  - **`"VEP"` en `usesConsortiumCuit`** — necesario y **no suficiente**: esa función habilita el
    match de proveedor por nombre pero NO desactiva el match por CUIT, que corre antes. El papel
    trae el CUIT de la administradora ("Generado por el Usuario"), que es un proveedor real con
    boletas propias, y `cuitSanitizeStep` lo reinyecta en `allTaxIds` por regex después de la IA.
    **Sin el arreglo, todos los VEP quedaban imputados a ella.**
  - **Al VEP se le corta `allTaxIds`/`providerTaxId` en el matching de proveedor**, y el consorcio
    se matchea **sólo por CUIT** (el VEP no imprime la dirección del inmueble). `allTaxIds` completo
    sigue yendo a `matchConsortium`.
  - El guard de `clientNumber` se generalizó al grupo `usesConsortiumCuit`: ninguno usa `LspService`
    y su fast-path es terminal — un `Nro. VEP` colado ahí rebotaría el documento entero.
  - **La capa 0 del triage queda vacía** pero viva: nació con VEP y LSD, y los dos salieron al pasar
    a procesarse. Se conservan la firma, el gate y su lugar en el pipeline.
  - Detección por los marcadores ya calibrados, con la ventana de 200 caracteres que separa un VEP
    suelto de un F931 (que trae su propio VEP en la página 2). Test con el F931 real. Suite 899.
  - **Pendiente primario**: el VEP de un tercero que paga el consorcio (ej. la empresa de
    seguridad) va a Sin Asignar — su CUIT no es el del edificio.
- **Una Liquidación de Sueldos genera una boleta por empleado (2026-09-01)**. Los LSD llegan todos los meses
  y no se procesaban: el pipeline producía como máximo una `Invoice` por archivo, y un libro contiene
  el sueldo de varios empleados, cada uno un gasto distinto del edificio.
  - **`ctx.invoices`**: lista de boletas por archivo. Vacía = una sola (todos los documentos); con
    contenido = fan-out. Sólo `sheetsStep` y `persistStep` iteran; los otros 14 pasos no se enteran.
  - **El consorcio sale del CUIT del encabezado**, que el libro trae impreso — los 5 libros reales
    matchean exacto contra la base. No hace falta `LspService` ni identificar el edificio por el CUIL.
  - **El libro entra completo o no entra**: todos los CUIL dados de alta **y** todos los gastos fijos
    de empleado cubiertos. La segunda condición detecta que la IA se salteó a alguien; no se puede
    validar contra el papel, que no declara la cantidad de empleados.
  - **Hash derivado por empleado** (`sha256(archivo + CUIL)`), porque `Invoice` tiene unique
    `(clientId, documentHash)` y N boletas del mismo PDF lo violarían. **Sin migración.**
  - **Corte temprano por `driveFileId`**: como el hash derivado no reconoce un libro reprocesado,
    `dedupHashStep` consulta también por archivo y reusa la extracción guardada. Vale para todos los
    documentos, no sólo los libros.
  - **Tests 857 → 889.**

### Changed
- **El LSD deja de ser un no-boleta (2026-09-01)**. Salió del triage decisivo donde había entrado el
  2026-08-31 y pasó al router de prompts, con prompt propio. Va **primero** en `identifyLSPProvider`,
  antes que los sindicales: el libro nombra el convenio colectivo de la federación en la fila de cada
  empleado, que era el falso positivo FATERYH detectado el 2026-08-17.

### Added
- **Triage decisivo de no-boletas: VEP y LSD dejan de gastar requests (2026-08-31)**. *(El LSD salió
  de esta capa el 2026-09-01: ahora se procesa y produce una boleta por empleado. Queda sólo el VEP.)* Cada VEP y cada
  LSD gastaba una request de la cuota de Gemini para terminar rebotando, y cada reproceso la volvía a
  gastar. El triage de capa 1 no podía agarrarlos, y **no por falta de patrones**:
  `classifyDocumentType` exige marcador negativo **y ninguna señal de boleta**, y un VEP tiene `$`,
  `IMPORTE`, `VENCIMIENTO` y CUIT. Verificado sobre los 9 papeles reales: la heurística vieja los
  clasificaba a los 9 como `boleta`.
  - Capa 0 nueva (`detectDecisiveNotBoleta`): marcadores que descartan el documento **aunque tenga
    todas las señales de una boleta**, calibrados sobre 4 VEP y 5 LSD reales. **9 de 9 detectados**,
    0 falsos positivos sobre facturas y boletas de servicio.
  - **El F931 de ARCA no se rompe.** Se extrae con 2 páginas porque el importe está en el VEP de la
    página 2, así que su texto *contiene* "Volante Electrónico de Pago". Por eso el marcador de VEP
    sólo cuenta en los primeros 200 caracteres: un VEP suelto lo trae en el carácter 4, el F931 tiene
    la declaración jurada en la página 1. Con test que lo fija.
  - El tipo va al nombre del archivo (`[NO BOLETA - VEP]`) y a `m.reason`, que la instrumentación
    persiste en `ProcessingJob.reasonCategory`: se puede contar cuántas requests ahorró cada tipo.
  - **Tests 843 → 857.**

### Changed
- **Las no-boletas van a Sin Asignar, no a Revisión (2026-08-31)**. Decisión del owner: va a armar un
  flujo propio para procesar VEP y LSD como gastos, así que son documentos *pendientes de asignar* y
  no descarte — y tenerlos en una sola carpeta es lo que hace posible la limpieza manual antes de
  reprocesar. Alcanza también a las no-boletas que ya se detectaban (obleas, planos) y a las de capa 2.

### Fixed
- **`markNotBoleta` apilaba el prefijo al reprocesar (2026-08-31)**. Anteponía `"[NO BOLETA] "` sin
  quitar el que ya estuviera, así que devolver un archivo a Pendientes y volver a procesarlo daba
  `[NO BOLETA] [NO BOLETA] archivo.pdf`. Mismo bug que tuvieron las etiquetas de sufijo antes de
  `KNOWN_SUFFIX_TAGS`. Ahora es idempotente contra cualquier prefijo previo, con o sin tipo.

### Added
- **Instrumentación de requests y cuota de IA por boleta (2026-08-31)**. Hasta ahora no se
  registraba **ni una sola request**: `TokenUsage` guarda una fila por corrida y `Invoice` sólo
  existe para las boletas que entran, así que el 30% de tokens que no termina en ninguna boleta se
  podía calcular pero no atribuir. Y la cuota del free tier de Gemini se gasta **por request y por
  modelo** (~20/día cada uno, 3 modelos ≈ 60/día), no por token.
  - Cinco columnas nullable en `ProcessingJob` — `outcome`, `reasonCategory`, `aiRequests`,
    `usedVision`, `aiRequestsJson` —, la única tabla con una fila por archivo procesado entre o no
    entre como boleta. Migración `20260831000000_processing_job_metrics`.
  - `AiRequestCounter` por boleta, con la regla de que **incrementa quien hace la llamada HTTP,
    nunca el orquestador**: contar los intentos de la cadena haría que un barrido de 3 modelos de
    Gemini contara 1. En Gemini vive dentro de `generateWithTransientRetry`, así que el barrido y el
    reintento por 503 quedan contados en un solo lugar.
  - Seam `onOutcome` en el `finally` de `runPipeline` — el único punto por el que salen los ocho
    caminos de salida. A diferencia de `onDiagnostics`, lo inyecta el worker **siempre**. La
    escritura es best-effort: una métrica no puede hacer fallar una boleta ya procesada.
  - `scripts/metrics-cuota.sql` con las consultas: requests/día contra el techo de 60, abierto por
    modelo, rebotes por categoría, gasto por resultado y costo de los reprocesos.
  - **Tests 830 → 843.**

### Changed
- **Gemini pasa a primero en la cadena de extracción (2026-08-30)**. El orden queda
  **Gemini → Cerebras → OpenAI → Claude**. Cerebras venía devolviendo **402 (sin cuota)** en todas
  las boletas de la corrida del 28/08, así que la cadena ya dependía de Gemini de hecho, pero pagaba
  un intento fallido contra Cerebras en cada boleta. Es la pieza 1 del spec del 2026-08-24, que
  estaba diseñada y sin aplicar. **El riesgo del free tier sigue vigente**: con cuota diaria por
  modelo, un día de volumen alto quema el balde en las primeras boletas y el resto paga el barrido
  de los 3 modelos antes de caer al siguiente proveedor — con Cerebras sano detrás eso se absorbe,
  sin Cerebras no hay red.

### Docs
- **Pasada de verificación de pendientes contra la base de producción (2026-08-29)**. Sin cambios de
  código: se consultó la base para saber qué tareas del owner ya estaban hechas. Resultados:
  Edificio de Prueba **existe** (CUIT `11-11111111-9`, período 08/2026 activo, sin banco asignado);
  la migración `20260818120000_unique_cuit_por_cliente` está **aplicada** desde el 2026-08-19 con sus
  dos índices; los **47 consorcios tienen CUIT** (precondición de la reforma de matching); `AGIP`
  está cargado como proveedor pero **no tiene ni una partida en `_LspServices`**, así que el soporte
  de ABL sigue sin poder funcionar; los duplicados del ALTA y las altas de `RENZI MARIANA DEL PILAR`
  y `ASCENSORES CHERE` están resueltas. `docs/progreso.md` estrena un **tablero del owner** con el
  estado de las 13 tareas abiertas, y se corrigieron los "Estado: sin commitear" de las secciones de
  las sesiones 55-60, que ya estaban commiteadas y desplegadas.

### Changed
- **Facturas comunes: el matching de consorcio pasa a ser SOLO por CUIT (2026-08-26)**. Se eliminan
  los niveles por nombre (exacto / fuzzy / alias) para las boletas que no son LSP. El nombre y la
  dirección del receptor son texto libre que la IA recorta distinto según el formato: caso real, una
  factura con `Razón Social: CONSORCIO DE PROPIETARIOS EVA PERON` y el número sólo en la línea
  `Dirección: PERON EVA AV. 1711` normalizaba a "EVA PERON", ambiguo entre EVA PERON 1711 y 1761 —
  asignar por ahí es imputar el gasto al edificio equivocado. Las boletas **LSP** (servicios,
  sindicales, GENERIC_LSP) conservan el match por nombre: ahí la dirección impresa suele ser la
  única pista y `matchNames` existe para reconciliar variantes.
  > **Consecuencia operativa:** un edificio sin CUIT en `_Consorcios` deja de matchear cualquier
  > factura común. Hay que verificar que todos tengan CUIT cargado.
- **Cuatro etiquetas nuevas de Sin Asignar para facturas comunes (2026-08-26)**, que dicen cuál de
  los dos CUITs falta y de quién es el problema:

  | Categoría | Etiqueta en el archivo | Qué significa |
  |---|---|---|
  | `consortium_cuit_missing` | `CUIT DE CONSORCIO INEXISTENTE EN BOLETA` | El proveedor emitió sin el CUIT del receptor |
  | `consortium_cuit_not_registered` | `CUIT DE CONSORCIO NO REGISTRADO EN DB` | Está impreso, falta el alta |
  | `provider_cuit_missing` | `CUIT DE PROVEEDOR INEXISTENTE EN BOLETA` | No se pudo extraer el CUIT del emisor |
  | `provider_cuit_not_registered` | `CUIT DE PROVEEDOR NO REGISTRADO EN DB` | Está impreso, falta el alta |

  Para decidir de quién es el CUIT que falta cuando el papel trae **uno solo**, los candidatos a
  consorcio descuentan también los CUITs ya dados de alta como proveedor: si el único CUIT impreso
  es de un proveedor conocido, el que falta es el del consorcio. Sin eso se reportaba al revés y se
  invitaba a dar de alta un edificio con el CUIT de un proveedor.

  Las etiquetas viejas (`SIN CONSORCIO`, `CONSORCIO SIN REGISTRAR`, `SIN PROVEEDOR`,
  `PROVEEDOR SIN REGISTRAR`) siguen usándose para las boletas LSP. Sólo las `*_missing` disparan los
  fallbacks de código de barras AFIP y de visión: cuando el CUIT se leyó bien y lo que falta es el
  alta, ningún reintento lo resuelve y gastaría tokens al vacío.

### Fixed
- **Las etiquetas nuevas de CUIT no se apilaban al reprocesar (2026-08-28)**. `KNOWN_SUFFIX_TAGS`
  — la lista que `appendTag` usa para limpiar de forma idempotente — no incluía las cuatro etiquetas
  nuevas. La primera pasada las aplicaba bien (limpiaba la etiqueta vieja), pero un segundo
  reproceso habría dejado `x - CUIT DE ... - CUIT DE ....pdf`. Detectado revisando la primera corrida
  real en producción.
- **Un CUIT mal leído por la IA ya no bloquea el rescate por código de barras (2026-08-26)**. El
  fallback determinístico de la RG 1702 sólo corría cuando **no** se había extraído ningún CUIT de
  proveedor. Caso real (`Fact. 51837`): membrete en imagen, la IA devolvió `30-70701800-6` — un CUIT
  que **no figura en el papel** — y el código de barras dice `30-70741550-5`. Como había "un" CUIT,
  la puerta se cerraba y la boleta quedaba etiquetada con el CUIT equivocado, mandando a dar de alta
  un proveedor inexistente. Ahora el código de barras también corre cuando el proveedor **no
  matcheó** con un CUIT que sí se extrajo: cuesta 0 tokens y se autovalida (checksum + CAE + punto de
  venta impresos). La **visión** mantiene la puerta angosta, porque sí cuesta tokens. Si el CUIT del
  código tampoco está en el directorio, queda igual en `allTaxIds`, así que la etiqueta de Sin
  Asignar nombra el CUIT real del emisor y no el que leyó mal la IA.
- **Los CUITs de relleno ya no se toman como CUIT del consorcio (2026-08-26)**. `23000000000`
  **pasa** el checksum mod-11 (2×5 + 3×4 = 22), así que `extractCuitsFromText` lo levantaba como un
  CUIT válido. Caso real: ASCENSORES CHERE facturó al CONSORCIO DE PROPIETARIOS FRANKLIN 25 poniendo
  `CUIT: 23000000000` en el bloque del receptor en vez del CUIT real del edificio. Con las etiquetas
  nuevas, esa boleta se habría reportado como "CUIT de consorcio no registrado", invitando a dar de
  alta un edificio con un CUIT de relleno — y si alguien lo hacía, **todas** las boletas de todos los
  proveedores que usan ese mismo relleno se habrían imputado a ese único edificio. Nuevo
  `isPlaceholderCuit` en `lib/cuit.ts` (los 8 dígitos centrales todos iguales) que filtra en
  `extractCuitsFromText`. Cubre también el `11-11111111-9` del Edificio de Prueba.

### Added
- **Soporte de ABL / Impuesto Inmobiliario de AGIP (2026-08-25)**. Es la boleta más pobre en datos
  del pipeline: no trae CUIT (ni del emisor ni del contribuyente), ni nombre del consorcio, ni
  dirección del inmueble, ni número de comprobante. El **único** identificador es la PARTIDA, que
  va a `clientNumber` y se resuelve contra `LspService`, igual que el número de cliente de Edesur.
  Se detecta antes del gate `isUtilityBill` (el texto no tiene ninguno de sus marcadores) por
  `Ley 23.514` o el par `ALUMBRADO` + `BARRIDO`. Prompt propio `buildAblPrompt`: se registra el
  **1° vencimiento** (importe sin recargo) y el `boletaNumber` se construye como
  `<partida>-<MM/YYYY>` — el código de pago electrónico no cambia entre cuotas y no sirve para
  deduplicar. Decisiones del owner.
- **El fast-path LSP resuelve el proveedor por nombre canónico cuando no hay CUIT (2026-08-25)**.
  El sync de directorio crea los `LspService` con `providerName` pero sin `providerId`, así que sin
  esto una boleta de ABL se guardaba sin `Provider` y las obligaciones de gasto fijo — que comparan
  `providerId` — nunca se marcaban como recibidas. No es el "match por nombre" deshabilitado el
  2026-07-02: no compara contra el nombre que leyó la IA sino contra el nombre fijo de
  `LSP_ROUTER_TO_CANONICAL`, y el edificio ya quedó resuelto por la partida.

### Removed
- **Groq eliminado del proyecto (2026-08-25)**. Estaba fuera de la cadena de producción desde
  2026-06-25 (sin API key no se instanciaba), pero seguía ocupando lugar en el tipo `AiProvider`,
  en `AiExtractionChainConfig`, en `PROVIDER_ORDER`, en las env `GROQ_API_KEY`/`GROQ_MODEL`, en el
  `aiConfig` del pipeline y en los dos scripts de comparación. A pedido del owner se saca de todos
  lados. Reactivarlo, si alguna vez hiciera falta, es volver a agregar un `ProviderSlot`:
  `OpenAICompatibleExtractorService` sigue siendo genérico para cualquier API compatible con
  Chat Completions.

### Changed
- **El orden de la cadena de IA pasa a ser explícito (2026-08-24)**. Dejó de salir del orden físico
  de cinco bloques `if` y ahora se declara en un array (`PROVIDER_ORDER`). **El orden en sí no
  cambió**: sigue **Cerebras → Gemini → OpenAI → Claude**. Mover Gemini a primero está
  diseñado (pieza 1 del spec) pero requiere key de tier pago — con free tier, la cuota diaria por
  modelo se quema en las primeras boletas del día. Queda pendiente.
- **El barrido de modelos de Gemini pasa de 5 a 3 (2026-08-24)**. `gemini-2.0-flash` y
  `gemini-2.0-flash-lite` los dio de baja Google y devolvían 404: eran dos intentos garantizados al
  vacío cada vez que los tres primeros daban 503.
- **Un 503 reintenta el mismo modelo antes de degradar (2026-08-24)**. Una vez, tras 2000 ms. Saltar
  de una resuelve la boleta igual, pero la resuelve un modelo distinto del que le tocaba, con otra
  calidad y otro precio.

### Fixed
- **Un 503 de Gemini ya no manda boletas sanas a Revisión (2026-08-24)**. El barrido sólo devolvía
  la boleta a Pendientes si **todos** los modelos habían fallado por cuota (429); con todo en 503
  lanzaba un error genérico y una boleta correcta terminaba en revisión manual por una caída de
  capacidad de Google que dura minutos. Ahora los dos errores transitorios la devuelven a Pendientes.
- **El worker ya no queda clavado en el modelo caro (2026-08-24)**. `workingModelName` es estático,
  se seteó siempre que hubiera éxito y no expiraba: si `2.5-flash-lite` daba 503 y resolvía
  `2.5-flash`, todas las boletas siguientes arrancaban por `2.5-flash` hasta el próximo reinicio —
  3× el precio del input y 6× el del output, en silencio. Ahora el pegado sólo aplica cuando el
  salto fue por cuota (429).
- **El fallback visual registra sus tokens (2026-08-24)**. `extractPartiesFromImage` era el único
  camino que gastaba tokens sin dejar rastro en `TokenUsage`, así que el consumo real de la cuenta
  quedaba subestimado.

### Added
- **`isTransientServerError` (2026-08-24)**: clasifica 503 / `UNAVAILABLE` / "overloaded" /
  "high demand", separado de la cuota agotada (429). No confunde el 404 de un modelo dado de baja.
- **Tests de `GeminiExtractorService` (2026-08-24)**: no tenía ninguno. 19 tests sobre el barrido de
  modelos, el reintento del 503, el desenlace del barrido completo, el modelo pegajoso y los tokens
  del fallback visual. Suite **771 → 799**.


### Fixed
- **La vista de obligaciones ya no queda cargando en bucle (2026-08-20)**. Al desplegarla quedaba
  pestañeando con "Sincronizando y cargando…" sin mostrar nada: `setMonth` devolvía un objeto nuevo en
  cada vuelta, así que el efecto de carga se re-disparaba solo — 1519 sincronizaciones medidas. Ahora
  conserva la referencia cuando el mes no cambió, y sincronizar corre una vez al montar en vez de en
  cada flecha. Se agregaron tests del ciclo de carga, que no existían: son los que faltaban para
  atajarlo antes del deploy.
- **El deploy ya no se queda sin disco (2026-08-20)**. Falló con `no space left on device`: había 31
  imágenes ocupando 65 GB y 28 no las usaba nadie. El workflow ya tenía un `docker image prune -f`,
  pero sin `-a` sólo borra imágenes colgadas, y las de cada deploy quedan tageadas con el SHA — el
  paso corría sin limpiar nada. Ahora limpia con `-a` y filtro de 7 días, y lo hace **antes** del
  pull, que es donde falta el espacio.

### Changed
- **La vista de obligaciones es por mes y no arrastra nada sola (2026-08-20)**. Mostraba todas las
  boletas impagas de períodos cerrados, que con los pagos fuera de la app eran 1124 de 1125: una
  pantalla llena de ruido que tapaba lo único que importa, lo que hay que pagar este mes. Ahora se
  elige un mes y se ve sólo eso, con flechas para navegar. Lo único que cruza de un mes a otro es lo
  que se marca a mano con "Pasar al mes siguiente"; el traslado se ejecuta después de cerrar el
  período, por tandas y con barra de avance. Se puede deshacer antes o después de ejecutarlo.
  Requiere la migración `20260820000000_invoice_carry_over_requested`.

### Added
- **Corrida selectiva de boletas con diagnóstico (2026-08-18)**. **Ejecutar ahora** ya no procesa todo
  lo que haya en Pendientes: abre un modal donde se eligen hasta 10 boletas, se encolan y se sigue su
  avance archivo por archivo. Las procesa el worker, que nunca dependió del flag del scheduler, así
  que funciona igual con el scheduler prendido o apagado. Al terminar queda un reporte en
  `Pendientes/_diagnosticos`: un JSON con el detalle de cada boleta —métricas, lo que extrajo la IA
  antes y después de canonizar, y el texto exacto que se le mandó al modelo— y un `.md` con el
  resumen. Requiere la migración `20260818000000_processing_job_diagnostics`.

### Fixed
- **El CUIT ya no se puede repetir (2026-08-18)**. `Provider` tenía unique en la razón social pero no
  en el CUIT: dos registros podían compartirlo y el matching le colgaba la boleta a cualquiera de los
  dos, sin orden garantizado. Ahora el sync detecta filas repetidas en el ALTA —por CUIT y por razón
  social—, las informa en el modal y **no las aplica**, y un índice único cierra la puerta para los
  demás caminos de alta. Lo destapó una fila cargada dos veces; en la hoja había dos casos. El alta
  de edificios desde el panel, que no validaba ni normalizaba el CUIT, ahora hace lo mismo que la
  de proveedores: guarda el formato canónico y avisa con un mensaje claro en vez del error crudo
  de Postgres. Requiere la migración `20260818120000_unique_cuit_por_cliente`.
- **El vencimiento del CAE ya no entra como fecha de pago (2026-08-18)**. Una factura entró con el
  vencimiento del CAE como `dueDate` — un dato falso, silencioso, que después alimenta la deuda del
  mes. El prompt ya lo prohibía; el modelo lo devolvió igual, y su boleta hermana con el mismo layout
  no. Ahora un guard determinístico anula el vencimiento si coincide con una fecha que el papel
  rotula como del CAE, sin depender de que el modelo obedezca. Lo detectó el primer reporte de la
  corrida selectiva, el mismo día que se estrenó.
- **El texto del OCR ya no se descarta por ser más corto (2026-08-18)**. Las facturas con el cuerpo
  en texto y el membrete en imagen rebotaban por SIN PROVEEDOR aunque el proveedor estuviera cargado:
  el OCR leía bien el CUIT del emisor, pero como su resultado era más corto que el texto de pdf-parse
  se tiraba entero. El criterio pasa a ser qué aporta y no cuánto mide — el OCR se conserva si trae
  un CUIT que el texto directo no tiene, validado por checksum. Detectado en tres facturas de
  Fumigaciones Miguel cuyo proveedor ya estaba en el directorio.

### Added
- **El CUIT del emisor se recupera del código de barras AFIP (2026-08-18)**. Las facturas con el
  membrete en imagen rebotaban por SIN PROVEEDOR aunque el CUIT estuviera en el texto, escondido
  dentro de los 40 dígitos del código de barras (RG 1702). Ahora se extrae de ahí, antes del
  fallback visual y sin gastar tokens. Se valida en cinco capas —prefijo de CUIT, checksum, fecha
  del CAE, y corroboración contra el CAE y el punto de venta impresos— porque sin eso el parser
  confundía códigos de pago electrónico con comprobantes y devolvía un CUIT falso. Cobertura medida
  sobre 60 boletas reales: 6% las trae como texto, con 0 falsos positivos.
- **Los PDFs escaneados se leen con Gemini Vision (2026-08-17)**. Un PDF cuyas páginas son imágenes
  no tiene texto propio: el OCR devolvía algo ilegible, la IA no encontraba el importe y la boleta
  terminaba en Revisión por SIN MONTO sin llegar nunca a la base. Ahora, cuando pdf-parse no saca
  texto, la página 1 que ya renderizó el OCR va a Vision — el mismo camino que usan los archivos
  JPG/PNG. La degradación no pierde boletas: si Vision falla sigue la cadena de texto, si se queda
  sin cuota el PDF vuelve a Pendientes, y sin Gemini configurado todo queda como estaba. El CUIT que
  lee Vision queda exento del saneo anti-alucinación, que lo habría descartado por no aparecer en el
  texto del OCR.

### Diagnosed
- **Por qué rebotaron las boletas de agosto (2026-08-17)**. Se diagnosticaron los 14 PDFs que apartó
  el owner. Ninguna causa era el prompt. La principal: la tabla `LspService` estuvo vacía hasta que
  la carga del ALTA de hoy insertó los 77 servicios, y el fast-path de asignación por número de
  cliente es terminal — mandó a Sin Asignar toda boleta de servicio en la que la IA leyó el número.
  No entró **ninguna** boleta de EDENOR en todo agosto. El resto: tres casos que ya funcionan (el
  consorcio o el proveedor se cargaron después del rebote), un CUIT de proveedor sin cargar
  (`ASCENSORES CHERE`), dos PDFs escaneados sin texto que el OCR no resolvió, y dos tipos de
  documento fuera de alcance (liquidación de sueldos y VEP de AFIP). Sin cambios de código; detalle
  en `docs/progreso.md` y `docs/decisiones.md`.

### Fixed
- **El sync de directorio ya no puede destruir datos (2026-08-17)**. Sincronizar con un nombre
  cambiado en el archivo ALTA borraba el registro viejo **en silencio**: el `try/catch` que prometía
  el aviso "no pudieron eliminarse porque tienen boletas asociadas" no podía dispararse nunca, porque
  todas las relaciones hijas de `Consortium` y `Provider` son `onDelete: Cascade` y el `deleteMany` no
  lanza — se llevaba períodos, gastos fijos, obligaciones y servicios, y dejaba las boletas sin
  edificio. Ahora el sync **no borra**: lo que está en la base y no en la hoja se informa en un modal
  nuevo, con cuántas boletas tiene colgando cada uno. En el caso que lo destapó (FRIAS 320 → 324)
  estaban en juego 6 períodos y 37 boletas.
- **Las boletas de servicios dejan de perder su vínculo en cada sincronización (2026-08-17)**. Rubros,
  coeficientes y servicios LSP se sincronizaban con borrado + alta: los registros recreados tenían
  `id` nuevo y, por `onDelete: SetNull`, todo lo que los apuntaba quedaba en null. Por eso hay hoy 70
  boletas de Edesur, Metrogas, AySA y Edenor sin su `lspServiceId` — sin ese dato no se distingue el
  medidor del edificio del de un local. Pasan a upsert por clave natural, conservando el `id`. Las
  boletas ya desvinculadas necesitan un script aparte: el número de cliente no está en `Invoice`.
- **El sync deja de rozar el timeout de 100 s del túnel (2026-08-17)**. Tardaba 119,9 s, de los cuales
  84,7 s eran los 176 proveedores: los `Promise.all` de `tx.update` no paralelizan, porque dentro de
  una transacción de Prisma todas las queries van por la misma conexión. Ahora un diff en memoria
  descarta lo que no cambió —un sync de rutina no ejecuta ni un update— y lo que sí cambió se escribe
  con un único `UPDATE ... FROM (VALUES ...)` por entidad.

### Added
- **La hoja `_Proveedores` habla el idioma del administrador, admite varios alias y suma el oficio
  (2026-08-17)**. Los encabezados pasan a `RAZÓN SOCIAL · CUIT · NOMBRE FANTASÍA · ALIAS DE PAGO ·
  TIPO · OFICIO` — "nombre canónico" era jerga interna, y lo que va en la columna C es el nombre con
  el que la empresa aparece en sus boletas. **Los campos de la base no se renombran**: el sync lee por
  posición, así que los rótulos son informativos y ahora **se corrigen solos** cuando difieren (antes
  sólo se escribían al crear la hoja, así que un ALTA existente se quedaba con la terminología vieja).
  Un proveedor pasa a admitir **hasta 3 alias de pago** separados por `|` en el mismo campo, y cada
  uno puede ser un alias o un CBU indistintamente: van los tres a la columna ALIAS de la hoja de
  boletas separados por ` · `, uno debajo del otro en la planilla imprimible —cuyo encabezado pasa de
  "ALIAS CBU" a **"ALIAS - CBU"**, porque lo que muestra es el destino del pago y no la cuenta del
  edificio— y sólo el primero en el desplegable del modal de boleta. Aparece además el **oficio** de
  cada proveedor (Pintor, Albañil, Energía…), con catálogo propio en la hoja `_Oficios` nueva: **no es
  el Rubro**, que divide las secciones de una liquidación y agrupa varios oficios. Si la columna
  OFICIO menciona uno que no está en el catálogo, el proveedor se carga igual y el reporte lo avisa.
  **Requiere migración** (`20260817000200_oficio`). +17 tests (636 → 653).
  Ver `docs/decisiones.md` (2026-08-17).
- **Tipo `SERVICIO` en el catálogo de proveedores (2026-08-17)**. `ProviderType` gana un tercer valor
  para las empresas de servicios (Edesur, Edenor, AySA, Metrogas, Naturgy, Camuzzi, Litoral Gas,
  Personal), que hasta ahora eran indistinguibles de un proveedor común aunque tengan reglas propias
  en todo el resto del sistema. Se carga desde la columna E ("TIPO") de la hoja `_Proveedores`, que ya
  existía. Al sincronizar, si un servicio apunta a un proveedor que no está marcado como `SERVICIO`,
  el reporte lo avisa — **sin bloquear**: el vínculo entre la boleta y el servicio lo resuelve el
  pipeline por el número de cliente del PDF, no el catálogo. El parseo de esa columna salió a una
  función pura (`lib/providerType`) con sesgo conservador: celda vacía o texto no reconocido caen a
  `PROVEEDOR`. `SERVICIO` se comporta como proveedor común en pagos (parcial) y en el modal de boleta
  (CUIT, no CUIL), ahora con tests que lo fijan. **Requiere dos migraciones**
  (`20260817000000_provider_type_servicio` y `20260817000100_backfill_provider_type_servicio`): el
  `ADD VALUE` va solo porque Postgres no permite usar un valor de enum en la misma transacción que lo
  creó, y el backfill marca a los proveedores que ya tienen servicios cargados. Sin cambios de UI.
  +9 tests (627 → 636). Ver `docs/decisiones.md` (2026-08-17).
- **Confirmación de renombres en el sync de directorio (2026-08-17)**. Cambiar el nombre de un
  edificio o proveedor en el ALTA ya no crea un duplicado: si el CUIT apunta a exactamente un registro
  que no figura en la hoja, se ofrece como renombre en un modal con el nombre viejo, el nuevo, el CUIT
  que los emparejó y cuántas boletas y períodos hay en juego. **Nada se aplica solo** — cada fila tiene
  su checkbox y el botón dice cuántos renombres va a aplicar. Al confirmar, el nombre anterior se suma
  a `matchNames`, para que las boletas que lo traigan impreso sigan matcheando. La confirmación va por
  un endpoint aparte que recibe la lista exacta que se mostró en pantalla y no re-deriva nada de la
  hoja. Piezas nuevas: `lib/directorySyncPlan` + `lib/bulkUpdate` (tier 0),
  `services/directorySync.service`, `sync-directory/renames` y `components/DirectorySyncModal`.
  El endpoint pasa de **cero tests** a tener su lógica en una función pura: +34 tests (591 → 625).
  Sin migración. Ver `docs/decisiones.md` (2026-08-17).

- **Arrastre de boletas impagas al mes siguiente (2026-08-12)**. Cuando no entran los pagos y una
  boleta de gasto fijo queda sin pagar, la vista de obligaciones la muestra en un bloque **"Impagas de
  meses anteriores"** al pie del edificio (en pantalla y en el PDF), y un botón **"Pasar a este
  período"** la mueve al mes corriente — Drive, Sheets y DB — para que el gasto quede registrado en el
  mes en que se paga. **La obligación del mes de origen no se vacía**: queda en el estado nuevo
  `CARRIED_OVER` conservando su boleta, así el período sigue mostrando que llegó y no se pagó (lo que
  exige una rendición de cuentas). Las boletas de servicios traen un 2° importe por pago fuera de
  término que el pipeline no extrae: se carga a mano con **"Cargar monto vencido"** (`Invoice.lateAmount`),
  que recalcula el saldo por la diferencia y pasa a ser la base del "pagada"; se muestran el 1° y el 2°
  pago, sin la resta. `Invoice.carriedFromPeriodId` registra el origen una sola vez, así un arrastre
  encadenado sigue diciendo el mes real. +48 tests (543 → 591). **Requiere migración**
  `20260813000000_carry_over_unpaid_invoices`. Ver `docs/decisiones.md` (2026-08-12).
- **Hoja imprimible de obligaciones — PDF e impresión (2026-08-12, Parte 2)**. La vista de
  `/admin/obligaciones` gana dos botones: **Descargar PDF (N)**, que arma el documento con `jsPDF` +
  `jspdf-autotable` y lo baja al dispositivo (una hoja A4 por edificio, banco y período en el
  encabezado, las seis columnas de la planilla, pie con la fecha de generación, archivo
  `obligaciones-julio-2026.pdf`), e **Imprimir**, que manda la misma vista a la impresora con un
  `@media print` que esconde barra, buscador y acciones de fila y pagina un edificio por hoja. Qué se
  encabezado `BANCO: … · PERIODO: …`, columna MONTO de 36mm para que un importe de millones no se
  parta en dos líneas, filas compactas y el nombre del banco normalizado a title case sólo en el
  papel. Qué se
  imprime lo decide una sola función pura (`toPrintableSheets`): sin salteadas, sin desactivadas, sin
  edificios sin período y sin hojas que quedarían en blanco — la usan el PDF y también la impresión,
  así el archivo y el papel no pueden diferir. Las librerías se cargan con `import()` dinámico (no
  pesan en el bundle hasta que se aprieta Descargar). +20 tests (544 → 564). Sin migración y sin
  cambios de backend. Ver `docs/decisiones.md` (2026-08-12).
- **Vista global de obligaciones (2026-08-12, Parte 1)**. Nueva pantalla `/admin/obligaciones`
  (botón en el sidebar, rol CLIENT) con los gastos fijos de todos los edificios agrupados por banco,
  cada uno con la forma exacta de la hoja que después se va a imprimir: FACTURAS · PROVEEDORES Y
  SERVICIOS · MONTO · ALIAS CBU · TÉCNICO O GESTOR · TEL. CONTACTO. El monto sale de la boleta cuando
  llegó; las dos últimas columnas van vacías (el modelo todavía no guarda datos de contacto). Desde
  la misma pantalla se agregan gastos fijos **de a varios** (modal con checkboxes que esconde lo ya
  cargado), se desactivan, se eliminan (con aviso de que arrastra el historial de obligaciones) y se
  omiten o reactivan las obligaciones del mes. Al abrir, la vista **sincroniza sola** las obligaciones
  faltantes de todos los períodos activos con una función set-based (~5 queries para la cartera
  entera), así la lista nunca sale incompleta; si esa sincronización falla, la vista carga igual con
  un aviso. Piezas nuevas: `obligaciones/lib/sheetModel` + `obligaciones/lib/availableTargets`
  (tier 0), `obligaciones/hooks/useObligationsOverview` (tier 1), `obligaciones/components/SheetCard`
  + `AddFixedExpenseModal` (tier 2), y los endpoints `/api/client/obligations/overview` y
  `/api/client/obligations/sync`. Todas las acciones de fila usan `AsyncButton` (spinner + disabled +
  guard anti doble-click) y son botones rectangulares con área de toque propia (40px de alto en
  mobile); el tachado de una fila omitida afecta sólo a los datos, no a sus botones. **No hay borrado
  de gastos fijos**: la baja se hace desactivando, porque el borrado físico arrastra las obligaciones
  de todos los períodos (`onDelete: Cascade`) y destruiría la evidencia que una rendición de cuentas o
  una auditoría necesita; los desactivados quedan al fondo de la lista de su edificio. Cada fila
  ofrece una sola acción de estado — la que lo revierte: "Saltear periodo"/"Agregar al periodo" para
  la obligación del mes, "Desactivar"/"Activar" para el gasto fijo.
  +52 tests (492 → 544). **Requiere migración**
  `20260812000000_unique_fixed_expense_target` (dos índices únicos que impiden cargar dos veces el
  mismo proveedor o servicio en un edificio). La Parte 2 —descarga de PDF e impresión sobre el mismo
  `SheetData[]`— queda pendiente. Ver `docs/decisiones.md` (2026-08-12).

- **Barra de progreso en tiempo real para las acciones masivas de Boletas entrantes (2026-08-06)**.
  "Borrar seleccionadas" y "Mover al período siguiente" dejan de estar limitadas a 10 boletas por
  tanda: ahora aceptan cualquier cantidad y el frontend las parte en tandas automáticas de
  `RUN_CHUNK = 5`, mostrando un modal con barra de progreso, contador, tiempo restante estimado por
  promedio medido en vivo, y la lista de boletas con su estado real (pendiente / en curso / hecha /
  salteada / fallida). Un fallo no corta la corrida: se marca en rojo y al terminar hay botón
  **Reintentar fallidas** (seguro — los endpoints ya eran idempotentes). Botón **Cancelar** que frena
  antes de la tanda siguiente. Piezas nuevas: `boletas/lib/batchProgress` + `boletas/lib/batchAdapters`
  (tier 0), `boletas/hooks/useBatchRunner` (tier 1), `boletas/components/BatchProgressModal` (tier 2).
  +34 tests (456 → 490). **Sin migración y sin cambios de backend** — los `.max(10)` de los endpoints
  siguen vigentes y se les mandan 5. Ver `docs/decisiones.md` (2026-08-06).

### Removed
- **El matching por alias de pago al escanear una boleta (2026-08-17)**. Al escanear un PDF, el modal
  intentaba pre-seleccionar el proveedor comparando el texto extraído contra su alias además de su
  razón social. Un alias es corto y coincide con demasiadas cosas: si existía un proveedor cuya razón
  social era "TIGRE" y otro con alias "TIGRE", ganaba el del alias y la boleta quedaba asignada a
  quien no era. Queda el match por CUIT y por razón social exacta, el mismo criterio que el pipeline
  desde 2026-07-02.

- **Estado `unknown` del modal de mover boletas (2026-08-06)**. Existía sólo para sobrevivir al
  timeout 524 del túnel con lotes de 10 (~85 s contra un techo de 100 s). Con tandas de 5 cada
  request dura ~46 s y, sobre todo, el manejo de error por boleta lo cubre mejor: una tanda sin
  respuesta interpretable marca esas 5 en rojo con "resultado no confirmado" y el botón Reintentar
  las reconcilia. Se fueron `pendingMoves`, `pendingItems`, `doneCount`, `stillPendingCount` y el
  paso `moveStep === "unknown"`. También se eliminó el estado `notice`, muerto desde que el resumen
  del borrado vive en el modal.
- **Bancos a nivel cliente + cuenta bancaria por consorcio + vista agrupada por banco (2026-08-03)**.
  Modelo `Bank` nuevo (catálogo por `Client`: nombre + color de una paleta fija de 8 slugs, con valor
  propio por tema para no romper el contraste). `Consortium` gana `bankId` (relación con
  `onDelete: SetNull` — borrar un banco desasigna edificios, no los borra) y los datos de su cuenta:
  `bankAlias` (alias CBU), `cbu`, `accountNumber`, `branch`, `accountType`, `accountHolder`. Una
  cuenta por edificio. La vista general de `/admin/consortiums` pasa a tener dos niveles: cards de
  banco con los edificios como badges (nivel 0) → la grilla de edificios existente filtrada por banco
  (nivel 1, sin cambios). ABM de bancos en modal desde el sidebar y sección "Banco y cuenta" en el
  acordeón de Configuración del consorcio. Endpoints `/api/client/banks` (GET/POST) y
  `/api/client/banks/[id]` (PATCH/DELETE). +37 tests (419 → 456). **Requiere migración**
  (`20260803000000_bancos_por_consorcio`). Ver `docs/decisiones.md` (2026-08-03).

### Changed
- **"Generar obligaciones" pasa a llamarse "Sincronizar gastos fijos" (2026-08-12)**. Es lo que
  siempre hizo: es idempotente y sólo agrega al período abierto los gastos fijos que todavía no
  tenían obligación. El nombre viejo sugería que creaba algo desde cero.
- **La sección "Gastos fijos" del modal de Configuración es ahora de solo lectura (2026-08-12)**.
  Muestra cuántos hay activos sobre el total y linkea a la vista de Obligaciones, que pasa a ser el
  único lugar de edición. Al quedarse sin el formulario de alta, la prop `providers` de `ConfigModal`
  se eliminó por falta de consumidores.
- **La columna O = BANCO de Google Sheets empieza a llenarse (2026-08-03)**. Estaba cableada desde
  siempre (`DEFAULT_SHEETS_MAPPING` + el pipeline la propagaba), pero salía vacía en todas las
  boletas: el campo `Consortium.bank` se **leía** y nunca se **escribía** — ni la UI, ni el sync ALTA,
  ni el import Excel lo tocaban. Ahora sale de la relación al catálogo (`consortium.bank?.name`). Las
  boletas ya procesadas no se reescriben.
- **El alias del consorcio ya no se carga por el archivo ALTA ni por el import Excel (2026-08-03)**.
  `Consortium.paymentAlias` se renombró a `bankAlias` y pasa a ser el alias CBU de la cuenta,
  editable sólo por UI. La hoja `_Consorcios` del ALTA baja de `A:D` a `A:C` y la hoja Edificios del
  template pierde la columna "Alias de pago". `Provider.paymentAlias`, la hoja `_Proveedores` y la
  columna I = ALIAS de Sheets **no cambian**: ahí el alias de pago es del proveedor y funciona.

### Docs
- **Evaluada y descartada la migración del backend a Go (2026-08-06)**. Análisis registrado como
  pendiente lejano, sin cambios de código. Bloqueante principal: `pdf-parse`/`pdfjs-dist` no tienen
  equivalente en Go y el pipeline entero está calibrado contra su salida literal. El cuello de
  botella medido (~8,5 s/boleta) es I/O de Drive, no CPU. Único corte sensato si se retoma: solo el
  `scheduler`. Ver `docs/decisiones.md` (2026-08-06) y `CLAUDE.md` → "Pendientes lejanos".
- **Corregida documentación desactualizada del borrado de boletas (2026-07-27)**. El comentario de
  `handleDeleteInvoice` en `consortiums/page.tsx` afirmaba que el borrado mueve el PDF `scanned→pending`;
  en realidad el borrado por consorcio lo manda a **Revisión** (`failed`) para que el scheduler no lo
  reprocese. Nueva sección en `CLAUDE.md` documentando los **dos destinos** según la vista (consorcio →
  `failed`, Boletas entrantes → `pending`) y que el destino `pending` es el camino para corregir una
  boleta mal procesada. Solo comentarios y docs — sin cambios de código.

### Fixed
- **Monto crítico mal extraído: IVA contenido (Ley 27.743) tomado como total (2026-07-27)**. La boleta
  `0003-00161074` (RANKO S.R.L.) se registró con $62.601,88 cuando el total era $360.706,09 — el monto
  guardado era exactamente el IVA contenido. Causa: el total no tiene rótulo textual en el PDF (la
  palabra "TOTAL" es parte del formulario preimpreso) y `pdf-parse` separa `IVA Contenido: $` de su
  valor por 16 líneas, dejando a la IA con rótulos vacíos y números sueltos. Nuevo guard determinista
  `src/lib/vatContainedAmountGuard.ts`, puro e idempotente, cableado en `refineExtractionWithRawText`
  (punto único de los 5 extractores + rama cacheada): auto-corrige solo si se cumplen 4 condiciones
  (marcador del régimen + identidad aritmética exacta para IVA 21%/10,5% + el candidato es la cifra
  máxima + el monto de la IA no lo es). No aplica a boletas LSP a propósito. Además se endureció el
  prompt de facturas con reglas explícitas del Régimen de Transparencia Fiscal. +15 tests (404 → 419).
  Ver `docs/decisiones.md` (2026-07-27).

### Refactor
- **Refactor `consortiums/page.tsx` — Fase 2, Tanda 3e Config · REFACTOR CERRADO (2026-07-27)**. Última
  sub-tanda: extraídos `useConsortiumConfig` (dominio Config completo — acordeón matchNames/LSP/gastos
  fijos, con el estado agrupado en sub-objetos y `load(c)` como punto de entrada del ciclo de vida) y
  `ConfigModal` (presentacional; recibe `providers` por props). **Disuelto el fan-out** de la Tanda 2: el
  bloque de config de `onConsortiumSelected` (11 setters + 2 fetches) colapsó a `config.load(c)`; el
  `setSelectedConsortium` post-guardado va por callback `onMatchNamesSaved`. Tipos `ConfigSection`/`LspForm`
  a `lib/types.ts`. `page.tsx` **1268 → 995 líneas (−273)**, **12 `useState`**, +10 tests (394 → 404).
  Sin cambios de comportamiento. **Balance del refactor completo: 3105 → 995 líneas, 91 → 12 `useState`,
  299 → 404 tests.** Ver `docs/decisiones.md` (2026-07-27) para la disolución del fan-out.
- **Refactor `consortiums/page.tsx` — Fase 2, Tanda 3d modal Boleta (2026-07-16)**. Extraído el modal más
  complejo: `useInvoiceModal` (scan IA + prefill + save con creación inline de coeficiente/rubro) +
  `InvoiceModal` + `MismatchModal`. Acciones de fila (borrar/recibo) quedan en page.tsx. `page.tsx`
  **1560 → 1268 líneas (−292)**, +8 tests (386 → 394). Sin cambios de comportamiento.
- **Refactor `consortiums/page.tsx` — Fase 2, Tanda 3c Shell (2026-07-16)**. Extraída la lógica del shell a
  4 hooks: `useSession` (auth/logout), `useTheme`, `useToolbarToast` (toast con autodismiss) y `useScheduler`
  (scheduler + 6 acciones de toolbar). El JSX del sidebar queda en `page.tsx`. `page.tsx` **1726 → 1560
  líneas (−166)**, +7 tests (379 → 386). Sin cambios de comportamiento.
- **Refactor `consortiums/page.tsx` — Fase 2, Tanda 3b modales globales (2026-07-16)**. Extraídos
  `useCloseAllModal` + `CloseAllModal` (Cerrar Período General) y `useUnassignedModal` + `UnassignedModal`
  (Sin Asignar), ambos modales de 2 pasos preview/result. `page.tsx` **1913 → 1726 líneas (−187)**, +10
  tests (369 → 379). Sin cambios de comportamiento.
- **Refactor `consortiums/page.tsx` — Fase 2, Tanda 3a Pagos (2026-07-16)**. Extraídos los modales de pago:
  `hooks/usePayModal` + `components/PayModal` (dos modos cuotas/libre, lógica derivada en el hook) y
  `hooks/useViewPayments` + `components/ViewPaymentsModal` (historial read-only). Tipos de pago a
  `lib/types.ts`. Disparados desde los callbacks de `PagosView`; recargan vía `reloadInvoices`. `page.tsx`
  **2297 → 1913 líneas (−384)**, +14 tests (355 → 369). Sin cambios de comportamiento. Primera de 5
  sub-tandas de la Tanda 3. Spec/plan: `docs/superpowers/{specs,plans}/2026-07-16-refactor-consortiums-tanda3*`.
- **Refactor `consortiums/page.tsx` — Fase 2, Tanda 2 (2026-07-16)**. Extraído el núcleo de detalle:
  `hooks/useConsortiumDetail` (cascada selección→períodos→boletas + `activeTab` + búsqueda + navegación +
  restauración por deep-link, **elimina el hack `handleSelectConsortiumRef`**), `hooks/useObligations`, y
  `hooks/useClosePeriod` + `components/ClosePeriodModal`. Costura **fan-out** (`onConsortiumSelected`) para
  disparar el estado de Tanda 3 que sigue en `page.tsx` sin adueñárselo. `page.tsx` **2418 → 2297 líneas**,
  **79 → 65 `useState`**, +16 tests (339 → 355). Sin cambios de comportamiento. Spec/plan:
  `docs/superpowers/{specs,plans}/2026-07-16-refactor-consortiums-tanda2*`.
- **Refactor incremental de `consortiums/page.tsx` — Fase 2, Tanda 1 (2026-07-16)**. Se empezó a
  descomponer el god-component de 3105 líneas / 91 `useState`. Extraídos a `lib/` los tipos, constantes
  y helpers puros de formato (`format.ts`, +13 tests) y matching (`match.ts`, +9 tests). Los modales
  **Crear Consorcio** y **Crear Proveedor** pasaron a `hooks/useConsortiumForm` + `hooks/useProviderForm`
  + `components/ConsortiumFormModal` + `components/ProviderFormModal` (tests tier 1 de hook + tier 2 de
  componente), y **`PagosView`** se movió a `components/PagosView.tsx`. Patrón: hook por dominio
  (estado + efectos + handlers, efectos cross-dominio vía callback `onCreated`) + componente
  presentacional; contrato "mover, no reescribir". `page.tsx` **3105 → 2417 líneas (−688)**, sin cambios
  de comportamiento. Spec/plan: `docs/superpowers/{specs,plans}/2026-07-16-refactor-consortiums-page*`.

### Testing
- **Infra de tests de UI (jsdom + testing-library) (2026-07-16)**. `vitest.config.ts` pasó a
  `test.projects`: proyecto `node` para `*.test.ts` (los 299 previos, intactos) y proyecto `jsdom` para
  `*.test.tsx` (hooks/componentes) con `vitest.setup.ts`. Nuevas devDeps: `jsdom`,
  `@testing-library/react`/`user-event`/`jest-dom`. Total de tests: 299 → **339** (+40).

### Security
- **Revocación de sesión en ≤60s (2026-07-15)**. Los guards de auth re-verifican `isActive` y rol
  contra la DB con cache en memoria de 60s (`src/lib/sessionRevocation.ts`): un cliente desactivado
  (o con rol degradado) pierde el acceso a la API en ≤60s, en vez de retenerlo hasta que expire el
  JWT de 24h. Fail-closed con tolerancia a blips de DB (usa el último estado conocido). Los guards
  pasaron a async (`await` propagado en las ~40 rutas que los llaman directo).
- **Errores 500 sanitizados en producción (2026-07-15)**. `apiError` y el catch del login responden
  "Error interno" en producción y loguean el detalle server-side (los mensajes de Prisma/Google
  filtraban nombres de tablas, queries e IDs internos). Los errores de negocio con status explícito
  (<500) y los de validación Zod no cambian.
- **Login sin enumeración de usuarios (2026-07-15)**. Cuenta inactiva responde "Invalid credentials"
  401 (igual que credenciales inválidas) en vez de "User is inactive" 403, que confirmaba la
  existencia del email. El motivo real va al log.
- **Firma JWT comparada en tiempo constante (2026-07-15)**. `verifySessionToken` usa
  `timingSafeEqual` en vez de `!==` (que cortocircuita y filtra timing).
- **Red de regresión de guards (2026-07-15)**. Test nuevo `src/app/api/routeAuthGuard.test.ts`:
  falla si una ruta API nueva no usa `withAuth`/`withClientAuth`/`require*Session` (allowlist
  explícita para las 5 rutas públicas intencionales). Verificado que detecta el negativo.

### Fixed
- **`bulk-delete` tenía el mismo patrón del 524 de close-all/bulk-move (2026-07-15)**. Aceptaba
  hasta 200 boletas con ~5 llamadas externas secuenciales cada una (Drive + re-lectura de la hoja
  entera de Sheets POR boleta) → un lote grande superaba con seguridad los ~100s del túnel. Ahora:
  tope 10 por tanda (server `.max(10)` + aviso en la UI, mismo criterio medido de bulk-move) y la
  hoja se lee **una vez por lote** (`deleteInvoicesWithIndex`: `loadRowIndex` + `findRowInIndex` +
  `deleteRowAtNumber`, con `adjustIndexAfterDelete` compensando el corrimiento de filas tras cada
  borrado). El borrado individual usa el mismo camino.

### Changed
- **Mapping de columnas de Sheets unificado (2026-07-15)**. `DEFAULT_SHEETS_MAPPING` (A–U) ahora
  vive SOLO en `src/lib/clientProcessingConfig.ts`; se eliminaron las 6 copias locales idénticas
  (pipeline, borrado, pagos ×2, protección de hoja, sync de pagos) que iban a divergir al agregar
  columnas.
- **Pasada de consistencia de docs (2026-07-15)**. CLAUDE.md al día con el código real: cadena de
  IA (Cerebras → Gemini → OpenAI → Claude), columnas A–U de Sheets, modelos Payment/FixedExpense/
  ExpenseObligation/ConsortiumProvider en el schema, matching de proveedor solo-CUIT, estructura de
  endpoints (boletas, pagos, obligaciones, bulk-*), y pendientes reales (se quitaron 2 ya
  implementados: URL de recibo y medio de pago en Sheets — columnas T y U).
- **Catch-up de UI sin documentar (sesión 37, jul 2026 — ya deployado)**. (1) Botón "Sincronizar
  pagos" **desactivado temporalmente** en el sidebar + botón "Consorcios" redirige a la vista
  general (`1ddb548`). (2) **Modal de preview de boletas** (iframe de Drive `/preview`) en lugar
  del link "Ver" en pestaña nueva; badge "Período actual" junto a "Edificios"; barra superior
  oculta dentro de un consorcio (`ae0791f`). (3) **Cards simplificadas**: sin el período por-card
  ni la aclaración "(todos los períodos)" en "Deuda total" (`b083eac`).

### Added
- **Migrar boletas al período siguiente (2026-07-10)**. Nueva acción masiva en `/admin/boletas`:
  seleccionar boletas y moverlas al período siguiente (+1 mes) de su consorcio, resolviendo DB +
  Google Sheets (celda PERIODO) + PDF en Drive (mover a la subcarpeta del mes nuevo + renombrar
  `P06-2026`→`P07-2026`) + obligaciones de gastos fijos. Sólo mueve a un período destino que exista y
  esté ACTIVE (sino saltea con aviso). Reversión por boleta ante cualquier fallo (orden Drive → Sheets →
  DB con pila de compensación LIFO). Modal de 2 pasos (preview → resultado). **Tope de 40 boletas por
  tanda** (cada una hace varias llamadas a Google → evita el timeout de ~100s del túnel; la UI avisa y
  el resto se hace en la siguiente tanda). La celda PERIODO se escribe con `USER_ENTERED`
  (`updateInvoicePeriodCell`) para que Sheets la muestre con el mismo formato que el resto de la hoja
  (ej. "julio-2026"), no como texto literal "07/2026". Sin migración de DB.

### Fixed
- **`bulk-move-period` daba 524 con lotes grandes (2026-07-13)**. Mover ~20 boletas superaba los 100s del
  túnel. Se optimizó Sheets (1 lectura/lote en vez de re-leer por boleta), el move pasó a ser idempotente
  por período destino explícito (reintentar es seguro), el frontend maneja el timeout sin romper (paso
  "unknown" + Reintentar) y se bajó el tope a 10 (medido en prod: ~8.5s/boleta, dominado por Drive; 20
  daba 169s → 524, 10 da ~82s single-shot). El modal de resultado desglosa los skips por motivo. Logs
  `moveLog` por boleta y lote.
- **`close-all` daba 524 y avanzaba períodos de más (runaway) con muchos consorcios (2026-07-12)**.
  "Cerrar Periodo General" con 47 consorcios hacía O(N) transacciones secuenciales → superaba los
  100s → Cloudflare cortaba con 524 (el `<!DOCTYPE` que el front parseaba como JSON), pero el server
  seguía commiteando y, al no ser idempotente, los reintentos empujaban el estado a agosto. Reescrito
  **set-based e idempotente** (`executeCloseAll` + `planCloseAll`): 1 transacción con `updateMany` +
  `createMany({ skipDuplicates })` (~4 queries, <1s); un reintento es no-op seguro. El preview reusa
  la misma planificación (se eliminó el cálculo duplicado del mes mayoritario).
- **`AsyncButton` quedaba en loading para siempre en dev (2026-07-09)**. El guard `mountedRef` se seteaba
  `true` solo en `useRef(true)` pero el `useEffect` nunca lo re-seteaba en el setup: con React StrictMode
  (default de Next en dev) el ciclo setup→cleanup→setup lo dejaba en `false`, y el `finally` saltaba
  `setPending(false)` → spinner eterno. Fix: `mountedRef.current = true` en el setup del effect. Afecta a
  todos los botones migrados a `AsyncButton` (se notaba en "Agregar" de Gastos fijos, que queda visible
  tras la acción). Solo se manifestaba en dev; en el build de producción StrictMode no duplica los effects.

### Changed
- **UX vista de consorcio: limpieza + Configuración con acordeón (2026-07-09)**. (1) Se quitaron las
  tarjetas **Duplicados** y **Rubros** de la solapa Boletas (ruido; el statsStrip queda con Boletas +
  Total período). (2) Las secciones **Servicios públicos (LSP)** y **Gastos fijos** se **movieron al
  modal de Configuración** del consorcio, que ahora es un **acordeón de una sola sección abierta a la
  vez** (Nombres alternativos / LSP / Gastos fijos), todas colapsadas al abrir. La vista principal queda
  más limpia. Se reemplazó el estado `lspCollapsed`/`fxCollapsed` por `openConfigSection`. (3) La solapa
  **Obligaciones** pasó a ser la **primera** (Obligaciones · Boletas · Pagos) y la **activa por
  defecto** al abrir un consorcio. (4) **Feedback de carga (`AsyncButton`) en los botones del modal de
  Configuración**: Gastos fijos (Agregar, Desactivar/Activar, Quitar) y LSP (Agregar, y el "Sí" de
  confirmación de borrado — "Eliminar" solo abre el confirm, no es async). Se eliminaron los estados
  manuales redundantes `savingLsp`/`deletingLspId` (los reemplaza el `pending` de `AsyncButton`) y se
  awaitea el refetch en toggle/quitar de gastos fijos para que el spinner cubra la actualización. Solo
  frontend (`src/app/admin/consortiums/page.tsx`), sin cambios de API/datos. Spec:
  `docs/superpowers/specs/2026-07-09-ux-vista-consorcio-config-design.md`.

### Added
- **Feedback de carga uniforme en botones — `AsyncButton` + `useAsyncAction` (Fases 1 y 2) (2026-07-09)**.
  Los botones no daban feedback al click → doble click → alta duplicada. Se estandarizó (DRY): hook
  `useAsyncAction` (guard anti doble-click + `pending`, con fix de StrictMode) que usa el componente
  `AsyncButton` por dentro. Fase 1: los 6 botones de gastos fijos/obligaciones. Fase 2: auditoría de todas
  las requests por botón → standalone/por-fila a `AsyncButton` (borra los `deleting*Id`), submits de modal
  al hook (borra el `useState(saving)` conservando la coordinación de hermanos), y el sidebar con
  `busyAction` global intacto (coordinación "una a la vez"). Ver
  `docs/superpowers/specs/2026-07-09-async-button-feedback-design.md`.
- **Gastos fijos + obligaciones de pago mensuales (2026-07-05)**. Cada consorcio define sus gastos fijos
  (luz/EDESUR, encargado, telefonía…) vinculados a un `Provider` o `LspService`. Por período se materializan
  **obligaciones** que aparecen "esperando la boleta"; el pipeline las vincula solas cuando llega la boleta
  (`RECEIVED`), y al cerrar el período las que faltan pasan a `NOT_RECEIVED` con aviso. Nuevos modelos
  `FixedExpense` + `ExpenseObligation` (enum `ObligationStatus`, migración `20260705000200_add_fixed_expenses`),
  servicio de obligaciones (generación idempotente + vínculo + cierre), endpoints CRUD + generación, y UI:
  sección "Gastos fijos" en el consorcio + **pestaña "Obligaciones"** con badge de faltantes. Solo panel/DB (no
  toca Sheets). Spec/plan: `docs/superpowers/{specs,plans}/2026-07-05-gastos-fijos-obligaciones*`. Ver decisiones.md.
- **Etiquetas de motivo en el nombre del archivo para casos sin procesar (2026-07-08)**. Igual que
  `SIN MONTO`, ahora los archivos que quedan sin asignar se renombran con el motivo, para verlo (y saber
  la acción) de un vistazo en la carpeta. El pipeline ya distinguía el motivo vía `reasonCategory`; solo
  faltaba reflejarlo en el nombre. 6 etiquetas: `SIN PROVEEDOR` (no hay CUIT de proveedor extraíble),
  `PROVEEDOR SIN REGISTRAR` (hay CUIT de proveedor en el papel pero no está en DB → darlo de alta),
  `SIN CONSORCIO` (no se extrajo el consorcio), `CONSORCIO SIN REGISTRAR` (se leyó pero no está en DB),
  `SIN PERÍODO` (consorcio OK sin período activo, va a Revisión), `LSP SIN REGISTRAR` (nº de cliente LSP
  no cargado). Se refinó `reasonCategory` para separar `*_not_found` (no se pudo extraer) de
  `*_not_registered` (identificador en el papel pero ausente en DB) — este último usa los CUITs reales
  del texto (`allTaxIds` tras `cuitSanitizeStep`). Nuevo helper puro `appendTag(fileName, tag)`
  **idempotente**: al reprocesar limpia la etiqueta previa (misma u otra) en vez de apilarla — resuelve
  el `- SIN MONTO - SIN MONTO` que se veía antes (`appendNoAmountTag` ahora pasa por él). +11 tests
  (helper + caracterización de gates).

### Fix
- **Boletas AFIP con monto caían a "SIN MONTO → Revisión" (2026-07-07)**. 13 facturas electrónicas
  AFIP ("Comprobante en línea") simples y con monto terminaban en Revisión etiquetadas `SIN MONTO`.
  Causa raíz: `pdf-parse` extrae la columna de importes **separada** de sus rótulos → el número del
  total queda flotando varias líneas arriba de un rótulo `Importe Total: $` **vacío**, y el modelo
  primario actual (Cerebras `gpt-oss-120b`, gratis, primero en la cadena) no logra reasociarlos →
  devuelve `amount: null`, que la cadena acepta como éxito (solo escala de proveedor ante excepción,
  no ante null) y `missingAmountGate` manda a Revisión. Fix: nuevo helper puro
  `reflowAfipTotals(text)` (`src/lib/afipTotalsReflow.ts`, +6 tests) que, antes de la IA, reescribe el
  rótulo `Importe Total: $` pegándole su número (regla confiable: el importe total es el número suelto
  inmediatamente anterior a la línea `Subtotal: $`). Verificado contra los 13 PDFs reales: los 13
  recuperan el total (ej. 288948,00 = 2×144474). Es model-agnóstico y no toca el camino feliz. Las
  boletas afectadas hay que recuperarlas manualmente (Revisión → Pendientes) para reprocesar. Detalle
  en `docs/decisiones.md` (2026-07-07).
- **Encabezados de columnas de pagos en la hoja Datos (2026-07-05)**. Las columnas O–U (BANCO, SALDO
  PENDIENTE, MONTO PAGADO, CANT CUOTAS, FECHA PAGO, URL COMPROBANTE, MEDIO PAGO) no tenían encabezado en
  hojas que ya existían antes de agregarlas: `ensureHeaderRow` era todo-o-nada y, si la fila 1 tenía
  cualquier celda con texto, no escribía nada. Ahora `GoogleSheetsService.ensureHeaders` **completa solo
  las celdas de encabezado vacías** sin pisar labels custom, y se auto-cura en el próximo append. Nuevo
  `scripts/ensure-sheet-headers.ts <cliente>` para completarlo de una en hojas existentes.
- **Pagos: tipo explícito (Total/Libre/Cuota) + fecha que aparecía un día antes (2026-07-05)**. (1) La
  fecha de pago se mostraba −1 día: es *date-only* guardada a medianoche UTC y `formatDate` la
  convertía a hora AR (UTC-3). Fix: formatear *date-only* en UTC + `todayInputDate()` en fecha local.
  Datos intactos. (2) El pago total inline se guardaba/rotulaba como "Libre". Se agregó el campo
  explícito `paymentType` (enum `TOTAL/LIBRE/CUOTA`) en `Payment` (migración
  `20260705000100_add_payment_type` con backfill), helper puro `resolvePaymentType` (+7 tests), y cada
  camino de UI declara su tipo: inline → TOTAL, modal "Pago libre" → LIBRE, cuotas → CUOTA. (3) El input
  inline "IMPORTE PAGO" **sugiere** el saldo completo con un `datalist` (se carga al elegir la sugerencia,
  no al hacer foco) y valida que el pago total coincida con el saldo (parciales van por el modal). El
  contador "N pago(s) sin guardar" y el guardado solo cuentan filas con pago real (monto > 0), así una
  fila con el input vacío ya no se registra. Ver decisiones.md.
- **Scheduler: un blip transitorio de DB (P1001) crasheaba el proceso (2026-07-04)**. Un error momentáneo
  de conexión al pooler de Supabase saltaba dentro de `discover()` sin try/catch → unhandled rejection →
  Node mataba el scheduler (Docker lo reiniciaba). Regresión del refactor del loop por cliente. Fix en 3
  capas: `discover()` y el `findActiveById` de `tick()` envueltos en try/catch (loguean + reintentan sin
  crashear), y `process.on("unhandledRejection"/"uncaughtException")` como red de seguridad que loguea sin
  salir. Nuevo log `schedulerLog.recoverableError`. Sin migración. Ver decisiones.md.

### Feature
- **Vista general de consorcios en tarjetas (2026-07-02)**. `/admin/consortiums` reemplaza la lista
  lateral por un grid de tarjetas (con buscador). Cada tarjeta muestra nombre, período activo,
  boletas del período, **Deuda mes** (período activo) y **Deuda total** (impaga de todos los
  períodos). Se muestran las dos deudas porque al cerrar un período la deuda del mes vuelve a $0
  (período nuevo vacío) pero la impaga arrastrada sigue contando en el total. Backend:
  `ConsortiumRepository.listByClient` agrega los stats por consorcio con 2 queries raw (deuda =
  `isPaid ? 0 : coalesce(remainingBalance, amount, 0)`). Incluye **deep-link** del consorcio
  seleccionado en la URL (`?c=<slug>-<id>`, híbrido: nombre legible + id inmutable que sobrevive a
  renombres) → F5 restaura el consorcio (con loader) en vez de volver al grid; sin endpoint nuevo.
  Solo lectura, sin migración. Ver decisiones.md.

### Changed
- **Heartbeat del worker configurable (2026-07-03)**. El log de vida del worker ("Cola vacía —
  esperando jobs") pasa de cada 5 min hardcodeado a configurable vía env opcional
  `WORKER_HEARTBEAT_MINUTES` (default 30, piso 1 min). Solo afecta ese log; el polling de 2s y el
  procesamiento de jobs no cambian. Con el default 30, apenas se deploya el heartbeat baja de 5 a 30
  min sin tocar el secret de producción. Archivos: `src/config/env.ts`, `src/jobs/jobWorkerMain.ts`,
  `.env.example`, `CLAUDE.md`. Ver decisiones.md.
- **Visión Gemini reforzada para el CUIT del membrete en imagen (2026-07-02)**. Complementa el
  matching solo-CUIT: cuando falta el CUIT del proveedor (o del consorcio) porque está en el
  membrete como imagen/logo, se lee con Gemini Vision. Mejoras sobre el fallback previo: (1) se
  dispara SOLO cuando falta un CUIT (`reasonCategory` = provider/consortium_not_found) → ahorro de
  tokens; (2) recorta la franja superior de la página 1 a 300 DPI (`@napi-rs/canvas`) en vez de la
  página entera a 200 DPI; (3) recupera emisor Y consorcio (sirve para boletas 100% imagen); (4)
  tolerancia 0 — el CUIT leído matchea exacto contra la DB o va a Sin Asignar. Cerebras es texto
  puro, así que la visión es siempre vía Gemini. 4 tests nuevos (170 total). Sin migración. Ver
  decisiones.md.
- **Matching de proveedor endurecido a SOLO CUIT (2026-07-02)**. Una factura de un proveedor NO
  cargado (ASCENSORES POTENZA) se asignaba por error a otro proveedor de la DB con nombre parecido,
  por el fallback de "nombre parcial" (`slice(0,5)` → dos *"ASCENSORES ..."* colisionaban). Ahora el
  proveedor se matchea solo por CUIT (`allTaxIds` / `providerTaxId`, excluyendo el del consorcio); si
  no está el CUIT del proveedor en la boleta → Sin Asignar. El match por nombre queda habilitado
  (`allowNameMatch`) SOLO para el conjunto cerrado de sindicales/ARCA (SUTERH/FATERYH/SERACARH/ARCA),
  que no tienen CUIT propio. El consorcio no cambia (CUIT + fallback nombre/fuzzy/alias). 166 tests
  (regresión del bug + gating). Sin migración. Ver decisiones.md.
- **Scheduler: loop independiente por cliente en vez de tick global fijo (2026-07-02)**. Antes había
  un `setInterval` global cada 5 min sobre todos los clientes, con throttle interno silencioso por
  cliente (`shouldEvaluateClient`) — el log `CICLO DE ESCANEO` aparecía cada 5 min sin importar el
  `intervalMinutes` configurado, dando la impresión de que el cambio no se tomaba. Ahora cada
  cliente corre en su propio `setTimeout` que se reprograma solo con su `intervalMinutes` fresco de
  la DB: el log de "Escaneando Drive" y su resultado aparecen exactamente cada `intervalMinutes` de
  ese cliente, sin logs de relleno. Un loop de discovery aparte (silencioso salvo altas/bajas)
  detecta clientes nuevos o desactivados. Ver decisiones.md.

### Fix
- **Activación de Cerebras en producción confirmada (2026-07-02)**. El secret `PROD_ENV_FILE` se
  completó con `CEREBRAS_API_KEY` + `DIRECT_URL` y se re-deployó. Confirmado revisando `docker logs`
  del worker en vivo: procesa boletas reales con `provider: cerebras`, `model: gpt-oss-120b` de
  forma consistente. Ya no está pendiente.
- **Deploy CI: login a GHCR en runner Windows self-hosted (2026-06-30)**. El job `deploy` fallaba
  en el `docker login` con `A specified logon session does not exist` — el credential helper de
  Docker Desktop (`credsStore: "desktop"`) requiere una sesión de logon interactiva que el runner no
  tiene, y Docker Desktop lo re-agrega al config global. Solución: **no usar `docker login`**; un
  step escribe el `auth` (base64 `usuario:token`) en un `config.json` propio del job
  (`DOCKER_CONFIG = github.workspace/.docker-ci`), y `docker pull`/`compose` autentican leyendo ese
  config. El job `build` (ubuntu) sigue con `docker/login-action` normal (en Linux no hay problema).
- **ARCA F931: monto inventado por truncado de texto (2026-06-22)**. En la primera corrida real,
  ARCA extrajo un monto **fabricado** (294.499,11 = suma de aportes de la DJ, cifra que no está
  impresa en el papel) en vez del total real del VEP (453.493,06). Causa: la DJ es larga y el
  "Importe total a pagar" del VEP cae ~línea 88, pero el prompt se cortaba a 80 líneas
  (`extractRelevantLines`) → la IA no veía el total y lo rellenaba sumando la DJ. Fix: para ARCA
  se pasa el texto completo (2 páginas, sin truncar a 80) y `buildArcaPrompt` exige copiar literal
  el "Importe total a pagar", prohíbe sumar/calcular y devuelve null si no aparece. 2 tests nuevos
  (146 totales).

### Feature
- **Groq fuera de la cadena de producción (2026-06-25)**. A pedido del owner, se sacó Groq del
  wiring del pipeline (`createProcessingContext`): la cadena de producción queda
  `Cerebras → Gemini → OpenAI → Claude`. Cerebras alcanza como principal; Groq se evaluará en el
  banco de pruebas. `createAiExtractionChain` y `OpenAICompatibleExtractorService` lo siguen
  soportando (reactivar = 1 línea). typecheck + 161 tests + build:jobs OK.- **Banco de pruebas local de LLMs (2026-06-25)**. Herramienta de desarrollo para iterar prompts y
  comparar modelos sobre boletas reales sin tocar producción. `src/lib/testbench.ts`
  (`runLogicalPipeline` + `compareToExpected`) replica la lógica del pipeline (extracción + triage +
  matching read-only + canonización) en **dry run** (no escribe DB/Sheets), y el CLI
  `scripts/llm-testbench.ts` lee una carpeta (`pruebas de LLMs/`, gitignored), corre cada boleta por
  cada modelo configurado y escribe `resultados.json` + `reporte.md`. Ground truth opcional
  (`<nombre>.expected.json` → aciertos por campo). 6 tests nuevos (161 totales). Sin migración.- **Más cuota de IA gratis: Cerebras + Groq en la cadena (2026-06-24)**. El throughput cayó a
  <½ del histórico porque Google recortó el free tier de Gemini (cuota diaria por modelo). Como
  predominan facturas variadas, se sumó **oferta** de IA gratuita en vez de tocar batchSize/
  frecuencia (que con tope diario solo cambian el ritmo). Nuevo `OpenAICompatibleExtractorService`
  (Chat Completions API de OpenAI, reutiliza el SDK con `baseURL`) → Cerebras y Groq. Cadena
  reordenada **capacidad primero**: `Cerebras → Groq → Gemini → OpenAI → Claude` (solo el
  pipeline automático; el scan manual no se tocó). `isRateLimitError` ahora reconoce el
  `status === 429` del SDK (el circuit breaker de cuota sigue válido con los nuevos). Env nuevas
  `CEREBRAS_API_KEY`/`GROQ_API_KEY` (+ `*_MODEL`); `docker-compose.yml` intacto (usa `env_file`).
  Script `scripts/compare-extractors.ts` para validar calidad sobre PDFs reales. Free tiers
  (06/2026): Cerebras 1M tokens/día (~300+ boletas, modelo `gpt-oss-120b` — Cerebras retiró Llama
  del free tier), Groq 1.000-14.400 req/día (`llama-3.3-70b-versatile`). Validado el 25/06 con un
  F931 de ARCA real (ambos sacan el monto correcto del VEP). 9 tests nuevos
  (155 totales); typecheck + lint + build:jobs OK. Sin migración.
- **Alta/edición de clientes: campo "Rendiciones" (statements) (2026-06-24)**. El formulario de
  crear/editar cliente (panel admin) ahora incluye la carpeta **Rendiciones**, obligatoria para
  procesar (sin ella el scheduler saltea el cliente). Backend (`POST`/`PATCH`/`GET` de
  `/api/admin/clients`) + UI (`admin/page.tsx` y `admin/clients/[id]/page.tsx`). Permite dar de
  alta un cliente 100% desde el panel sin tocar la DB. typecheck + lint + next build OK.- **UI Boletas entrantes: filtros + N° de boleta (2026-06-22)**. En `/admin/boletas`: nueva
  columna **N° Boleta** (últimos 4 dígitos) y tres **dropdowns combinados** arriba para filtrar
  por **consorcio**, **proveedor** y **periodo**. Filtrado **server-side**: la API
  `/api/client/invoices` acepta `consortiumId`/`providerId`/`period` (filtra todo el dataset,
  no solo la página; vuelve a página 1 al cambiar el filtro) y devuelve `facets`
  (consorcios/proveedores/periodos que realmente tienen boletas; periodos más recientes primero)
  para poblar los dropdowns. El **período se filtra por etiqueta MM/YYYY** y el dropdown se
  deduplica por etiqueta: cada consorcio tiene su propio `Period`, así que un mismo "06/2026" son
  muchos `periodId` distintos (filtrar por `periodId` traía un solo consorcio). Se agregó el campo
  `boletaNumber` a la respuesta. Sin migración.
- **Soporte ARCA F931 / SUSS (2026-06-15)**. El F931 de ARCA/AFIP (seguridad social del
  consorcio empleador) es recurrente y no se reconocía: el único CUIT del papel es el del
  CONSORCIO (no hay emisor con CUIT) y el total está en el VEP (página 2), no en la DJ. Nuevo
  tipo `"ARCA"` en `identifyLSPProvider` (detección por `931` + `S.U.S.S.`/`Organismo
  Recaudador`), helper `usesConsortiumCuit` que agrupa sindicales + ARCA (CUIT = consorcio,
  proveedor por nombre, fuera del fast-path LSP) y `buildArcaPrompt` (total del VEP, dueDate =
  Día de Expiración, boletaNumber = Nro. VEP, provider = "ARCA"). ARCA re-extrae 2 páginas. Sin
  cambios de schema: ARCA se registra en `_Proveedores` con CUIT vacío (ya soportado, como los
  sindicales). 6 tests nuevos (144 totales). PENDIENTE: commit + push + cargar ARCA en ALTA.
- **Distinción SERACARH en el nombre del proveedor (2026-06-15)**. Los consorcios con
  empleados reciben 2 boletas FATERYH (F0101 = aportes FMVDD/OS/ART 27 bis, y F0106 =
  SERACARH), que en el matching resuelven al mismo proveedor canónico "FATERYH" (SERACARH es
  anexo vía `matchNames`) → quedaban con nombre idéntico. Nuevo helper puro
  `annotateSindicalProvider` (`lib/extraction.ts`): cuando `lspProvider === "SERACARH"` anota
  `"FATERYH (SERACARH)"`. Se aplica una vez en `canonizeStep` → la distinción aparece en
  **Google Sheets, el nombre del archivo en Drive y el texto del proveedor en la DB**; el
  `providerId` (FK) no cambia. Idempotente. 5 tests nuevos. Sin migración.
- **Triage de documentos: boleta vs no-boleta (2026-06-15)**. La carpeta Pendientes recibía
  no-boletas (planos, certificados de fumigación, obleas de rúbrica, disposiciones) que igual
  pasaban por la IA y caían en "sin monto"/Sin Asignar. Nueva capa de triage **híbrida** sobre
  el pipeline: **capa 1** heurística (`src/lib/documentClassifier.ts`, 0 tokens) en
  `documentTriageGate` **antes** de la IA, y **capa 2** vía campo `isBoleta` de la IA en
  `isBoletaGate`. **Sesgo conservador**: solo desvía ante señal negativa fuerte + ausencia de
  señales de boleta (capa 1) o `isBoleta=false` explícito (capa 2); ante la duda sigue como
  boleta (una factura de fumigación con monto NO se desvía). El no-boleta se renombra
  `[NO BOLETA]` y va a Revisión, sin Sheets/DB; nuevo contador `summary.notBoleta` y
  `result="not_boleta"` en `[metrics]`. Se separó `extractStep` en `textExtractStep` +
  `aiExtractStep` para insertar el gate de heurística sin gastar tokens. 133 tests (incl. 2 de
  caracterización: heurística e IA). Sin migración. Spec/plan en
  `docs/superpowers/{specs,plans}/2026-06-15-triage-clasificacion-documentos*`. Deployado en
  `efe83b8` (CI #82/#83).

### Refactor
- **H2: `processDriveFile` descompuesto en un Pipeline de pasos (2026-06-15)**. La "God
  function" del pipeline (~630 líneas, ~13 deps, 7 caminos de salida con side-effects en
  Drive/Sheets/DB) pasó a patrón **Pipe & Filter**: un `PipelineContext` mutable fluye por
  14 pasos discretos `(ctx) => StepResult` y un `runner` (`src/jobs/pipeline/runner.ts`)
  los orquesta, corta al primer `halt` y **centraliza** el manejo de errores
  (`RateLimitError` → Pendientes / error → Revisión) + la emisión **única** de `[metrics]`
  en su `finally`. `processDriveFile` quedó como thin wrapper (~20 líneas). Refactor
  estructural **sin cambio de comportamiento**, blindado por 8 tests de caracterización
  nuevos (`processPendingDocuments.job.test.ts`) que cubren los 7 caminos (ok /
  duplicate-hash / duplicate-business-key / unassigned / no_amount / no_period /
  rate_limited / failed) y verifican `[metrics]` en cada uno. Los 2 `await import()`
  dinámicos (`resolveStatementsFolders`, `buildInvoiceFileName`) pasaron a seams
  inyectables del `ProcessingContext`. **121 tests verdes**, typecheck + lint (0 errores) +
  build:jobs OK. Sin migración. Archivos nuevos: `src/jobs/pipeline/{context,runner}.ts`.
  Spec/plan en `docs/superpowers/{specs,plans}/2026-06-14-refactor-h2-pipeline*`. Deployado en
  `efe83b8` (CI #79).

### Fix
- **Robustez del worker ante cortes del pooler de Supabase (P1017) (2026-06-14)**. El
  pooler (PgBouncer) cierra conexiones idle y se reinicia → Prisma lanza P1017. El blindaje
  del 11/06 cubría solo `claimNextJob`; un P1017 dentro de `handleJob` —sobre todo en
  `finalizeJob`— dejaba el job en PROCESSING (zombie) hasta el reaper (>30 min) y, si pegaba
  tras procesar OK, disparaba reproceso que gasta cuota IA. Nuevo `src/lib/dbRetry.ts`
  (`isTransientDbError` acotado a conexión transitoria + `withDbRetry`, espejando
  `callWithRetry` de aiErrors.ts) aplicado a claim/finalize/client lookup del worker (no se
  reusa `isPrismaConnectionError`, demasiado amplio). Scheduler intacto (ya resiliente).
  Nuevo log `workerLog.dbRetry`. 13 tests. Sin migración. Spec en
  `docs/superpowers/specs/2026-06-14-robustez-pooler-p1017-design.md`. Deploy: push +
  rebuild del worker.
- **Factura común: el consorcio receptor se ancla en "CONSORCIO DE PROPIETARIOS"
  (2026-06-14)**. "MAYO 2026.pdf" (factura C de desinsectación a CORONEL DIAZ 1714)
  iba a Sin Asignar: la IA tomaba la "Razón Social:" del EMISOR como consorcio y el
  refinamiento determinístico lo reforzaba (anclaba en esa misma "Razón Social:").
  En facturas tipo C el receptor no tiene CUIT real (`00-00000000-0`) → el match solo
  puede ser por nombre. Fix de doble capa: `buildInvoicePrompt` ahora le enseña a la
  IA que el receptor figura como "CONSORCIO DE PROPIETARIOS" + dirección (muchas
  veces sin etiqueta "Cliente:"), e `inferConsortiumFromText` ancla en ese marcador
  (no en "Razón Social:") limpiando el ruido del bloque receptor (condición IVA,
  CUIT placeholder, localidad). Cierra además un **bug latente**: el refinamiento
  podía DEGRADAR un consorcio bien extraído al nombre del emisor. 5 tests nuevos (con
  el texto real); `diag-boleta.ts` ahora infiere el consorcio del texto y prueba el
  match real → MATCH exacto "CORONEL DIAZ 1714". Sin migración. Recuperar
  "MAYO 2026.pdf" de Sin Asignar → Pendientes tras el deploy.
- **Router: "PERSONAL" suelto mandaba facturas a Telecom (2026-06-13)**. Una
  factura de IPLAN caía en Sin Asignar porque `CÓDIGO DE GESTIÓN PERSONAL` activaba
  la detección de Personal/Telecom (camino LSP por nro de cliente). Ahora
  `isPersonalTelecom` detecta por marcadores positivos (TELECOM ARGENTINA, Mi
  Personal, Personal Flow/SA), no por la palabra suelta → esas facturas van al
  flujo normal y matchean por CUIT. 3 tests nuevos (incl. texto real de IPLAN).

### Features
- **Vista "Boletas entrantes" + borrado masivo (2026-06-13)**. Nueva página
  `/admin/boletas` en el panel cliente: todas las boletas en orden de entrada
  (como el Sheet), sin separar por edificio, con selección múltiple y "Borrar
  seleccionadas". Al borrar, el PDF vuelve a **Pendientes** y se reprocesa (ideal
  para corregir boletas mal procesadas). Endpoints `GET /api/client/invoices` y
  `POST /api/client/invoices/bulk-delete`; el flujo de borrado se extrajo a
  `lib/invoiceDeletion` (destino configurable) y lo comparte el borrado por
  consorcio. Ítem "Boletas entrantes" en el sidebar.

### Fix
- **Boletas sindicales: el CUIT del documento es del consorcio, no del sindicato
  (2026-06-13)**. Corrige el soporte sindical del 12/06, que asumía mal un "CUIT
  recaudador compartido". Cada boleta trae el CUIT del **edificio contribuyente**
  (BOEDO 414 ≠ BROWN 706 ≠ …). Ahora: el consorcio matchea por ese CUIT y el
  **proveedor por NOMBRE** (SUTERH/FATERYH/SERACARH, sin CUIT propio). El prompt
  ya no hardcodea `providerTaxId`; `extractCuitsFromText` corre también en
  sindicales; el fast-path LSP las excluye. Verificado 6/6 contra PDFs+DB reales.
  **Requiere** limpiar el CUIT mal cargado de los 3 proveedores (SQL en
  `docs/decisiones.md`).

### Fix
- **Boletas con cuota agotada caían a "SIN MONTO → Revisión" (2026-06-12)**. El
  RateLimitError del barrido dice "sin cuota" (español) y el clasificador buscaba
  "quota" → con todos los proveedores en 429 la boleta degradaba a OCR_ONLY y
  terminaba en Revisión en vez de volver a Pendientes (también anulaba el circuit
  breaker). Fix de fondo: la cadena de IA clasifica el error sobre el objeto y
  pasa un flag `rateLimited` en el callback (el pipeline ya no parsea mensajes);
  defensa extra en `isRateLimitError` ("sin cuota"/"cuota agotada"). Etiquetas de
  log corregidas: "Movido a Revisión (carpeta failed)" y resultado real
  ("SIN MONTO → Revisión" / "SIN PERÍODO ACTIVO → Revisión") en vez del genérico
  "SIN ASIGNAR". 2 boletas afectadas a recuperar manualmente (Revisión →
  Pendientes): FB-158366.pdf y "eva peron manuel depto 32 - SIN MONTO.pdf".

### Features
- **Circuit breaker de cuota IA (2026-06-12)**. Cuando todos los proveedores de
  IA están en 429 (cuota diaria agotada), el worker pausa automáticamente el
  encolado del cliente (`SchedulerState.aiPausedUntil`, **migración
  `20260612000100`**) hasta el próximo reset de cuota (medianoche del Pacífico,
  DST-safe — nuevo `lib/quotaReset.ts`, 4 tests). El scheduler saltea al cliente
  sin escanear Drive y **se reanuda solo** al vencer la pausa, sin tocar el
  toggle manual. Elimina el churn de rebotes contra baldes vacíos.
- **Boletas sindicales SUTERH / FATERYH / SERACARH (2026-06-12)**. Soporte para
  los 3 formularios del sindicato de encargados (F0201/F0101/F0106) con el patrón
  LSP existente: detección en `identifyLSPProvider` (antes del gate de servicios
  públicos) + `buildSindicalPrompt` (provider y CUIT recaudador fijos, vencimiento,
  total, período, débito automático). Como los 3 comparten el CUIT 30-54675623-4,
  `matchProvider` ahora **desambigua por nombre cuando varios proveedores comparten
  CUIT** (mejora general, 5 tests). Detección verificada 12/12 contra los PDFs
  reales. Requiere cargar en el directorio: SUTERH, FATERYH y SERACARH (mismo
  CUIT) + matchNames `BOEDO 410` en BOEDO 414. `diag-boleta.ts` ahora muestra el
  tipo detectado por el router.

### Refactor
- **Normalización canónica de CUIT en todo el sistema (2026-06-12)**. Nueva fuente
  única `src/lib/cuit.ts` (13 tests TDD): comparar siempre por dígitos
  (`cuitDigits`/`cuitsEqual`), guardar siempre canónico `XX-XXXXXXXX-X`
  (`formatCuit`). Consolidadas 6 copias de normalizadores locales (job, matching,
  scan, panel, extraction, validación). Escrituras normalizadas: alta manual de
  proveedores, sync ALTA, import Excel (cuyo dedup por `contains` no matcheaba
  formatos mixtos — bug). La IA ahora devuelve `providerTaxId` y `allTaxIds`
  canónicos desde el schema Zod. Nuevo `scripts/normalize-cuits-db.ts` (dry-run /
  `--apply`) para unificar el stock existente.

### Fix
- **CUITs extraídos del texto por regex+checksum (2026-06-12)**. Una boleta clara
  con proveedor correctamente cargado caía en Sin Asignar: la IA listó un solo
  CUIT (el del consorcio) malformado → el saneo lo descartó → `allTaxIds` vacío →
  sin puente CUIT entre el nombre de fantasía de la factura y la razón social
  cargada. Nuevo `extractCuitsFromText()` en `lib/documentValidation.ts` (regex
  con prefijos válidos + verificación mod-11; 8 tests TDD): el pipeline une los
  CUITs reales del papel a los de la IA (solo no-LSP). Probado e2e con el PDF
  real: ahora matchea por CUIT. Recuperar las boletas afectadas con "Reprocesar
  Sin Asignar" tras el rebuild del worker.

### Fix
- **Barrido de modelos Gemini restaurado (cuota diaria por modelo) (2026-06-11)**.
  Log de prod reveló que el free tier de Gemini tiene cuota **diaria por modelo**
  (`limit: 20`, `GenerateRequestsPerDayPerProjectPerModel-FreeTier`): el barrido
  original sumaba ~6 baldes (los 429 no consumen cuota) y al unificar a 1 modelo
  quedó 1 balde de 20/día. Se restaura el barrido (5 modelos, sin 2.5-pro, con
  `workingModelName`) conservando el anti-pérdida: todos sin cuota →
  `RateLimitError` → boleta a Pendientes. Corrige el análisis del fix del 10/06.
  Recomendación: tier pago (~USD 1-2/mes a este volumen) como solución definitiva.

### Observabilidad
- **Logs de diagnóstico de throughput (2026-06-11)**. Worker: profundidad de cola
  al reclamar cada job ("En cola: N detrás" — si es 0, el límite es el
  scheduler/batchSize; si crece, el límite es el worker) y heartbeat "cola vacía"
  cada 5 min. Scheduler: contador "Ya cargadas" en el resumen del ciclo.
  Contexto: se detectó que el throughput de 1 boleta/5min era el techo de
  `batchSize=1` + `intervalMinutes=5` (config del cliente, editable desde el
  panel admin), no un bug.

### Fix
- **Destrabe de Pendientes + jobs zombie + robustez del worker (2026-06-11)**.
  Tres fixes tras verificar en prod (DB + logs):
  - **Scheduler:** los PDFs de Pendientes que ya tienen Invoice ahora se **mueven
    a Duplicados** (o Escaneados) en vez de saltearse eternamente — destraba los
    14 archivos que loopeaban. Nuevo log `alreadyLoadedMoved`.
  - **Scheduler:** reaper de **jobs zombie** (PROCESSING > 30 min, de workers
    caídos) → PENDING o FAILED según intentos. Recupera 2 boletas perdidas de
    mayo. Nuevo log `staleJobsRecovered`.
  - **Worker:** `claimNextJob` blindado con try/catch + espera — un corte del
    pooler de Supabase (P1017) ya no crashea el proceso.
  Verificado además en prod que el fix 429 funciona: 35 boletas el 11/06, todas
  con `gemini-2.5-flash-lite`, sin barrido de modelos. Requiere rebuild de
  scheduler y worker.
- **Regresión 429 / throughput de boletas (2026-06-10)**. Se corrige la caída de
  procesamiento por rate-limit (cuota) de Gemini. **Causa raíz:** el extractor
  barría 6 modelos y reintentaba con cada uno ante un 429 → 6× consumo de cuota por
  boleta (confirmado en `logs/2026-06-08_15-43_worker.txt`). **Fix:**
  - `geminiExtractor.service.ts` usa **1 modelo configurable** (`GEMINI_MODEL` o
    default `gemini-2.5-flash-lite`) en vez de barrer 6.
  - Nuevo `src/lib/aiErrors.ts`: `isRateLimitError`, `RateLimitError` y
    `callWithRetry` (backoff acotado que reintenta solo ante 429). 16 tests (TDD).
  - El pipeline ya **no pierde** boletas con 429: las devuelve a Pendientes y el
    scheduler las re-encola en un ciclo posterior (sin loop de reintento inmediato).
  Sin migración de DB; requiere rebuild del worker. La hipótesis del "cambio de
  orden del pipeline" se descartó con git (el orden texto→IA es el de siempre).

### Tests
- **Test runner (Vitest) + red de seguridad (2026-06-10)**. Primer runner de tests
  del proyecto: **Vitest 4** + `vite-tsconfig-paths`, `vitest.config.ts`, scripts
  `test`/`test:watch`. 39 tests en 3 suites: `consortiumNormalizer`,
  `AiExtractionChain` y `assignmentMatching`. Caracterización detectó que el ejemplo
  `"BROWN ALMTE AV 708" → "ALMIRANTE BROWN 708"` del JSDoc/CLAUDE.md es aspiracional
  (real: `"BROWN ALMIRANTE AV 708"`; se resuelve vía matchNames/fuzzy).

### Refactor
- **Patrones de diseño — Fase 3 parcial: H3 MatchStrategy (2026-06-10)**. La lógica
  de matching de consorcio/proveedor se extrajo de `resolveAssignment`
  (`processPendingDocuments.job.ts`) a un módulo puro y testeado
  `src/lib/assignmentMatching.ts` (`matchConsortium`/`matchProvider`, 4 niveles cada
  uno). El pipeline delega en él; logging y mensajes quedan en el caller.
  Comportamiento preservado. **Pendiente:** H2 (descomponer `processDriveFile` en
  pasos) requiere caracterización del pipeline completo (mock de ~8 dependencias) →
  sesión dedicada.
- **Patrones de diseño — Fase 2 (2026-06-10)**. Consistencia de capas y
  observabilidad. Sin cambios de comportamiento. Verificado con typecheck + lint
  + build:jobs + next build.
  - **H6 — Repository + Inyección de dependencias:** los 5 repositorios reciben
    `PrismaClient` por constructor (getter lazy, mockeable en tests). El pipeline
    (`resolveAssignment`) ya no accede a Prisma directo: las queries se movieron a
    `ConsortiumRepository.findAllForMatching`, `ProviderRepository.findAllForMatching`
    y un nuevo `LspServiceRepository`. Respeta la arquitectura por capas.
  - **H8 — Consolidación de logging:** `lib/logger.ts` gana `repoLog`/`apiLog`
    (+ `shortLogId`). Migrados `invoice.repository.ts` (cierra PII de `clientId`/hash
    en la capa de datos) y los `console.warn` de la ruta de scan. Resto incremental;
    scripts de diagnóstico y bootstrap mantienen `console.*` a propósito.
- **Patrones de diseño — Fase 1 (2026-06-10)**. A partir del reporte de auditoría
  `docs/reporte-patrones-diseno.md`. Sin cambios de comportamiento salvo lo
  indicado abajo. Verificado con typecheck + lint + build:jobs + next build.
  - **H1 — Extractores IA (Strategy + Chain of Responsibility):** nuevo
    `src/services/aiExtraction.ts` (interfaz `AiExtractor`, `AiExtractionChain`,
    `createAiExtractionChain()`). Los 3 servicios (`geminiExtractor`,
    `aiExtractor`, `claudeExtractor`) implementan el contrato. Se eliminó el
    fallback Gemini→OpenAI→Claude **duplicado** entre el pipeline
    (`processPendingDocuments.job.ts`) y la ruta de scan manual
    (`consortiums/[id]/invoices/scan/route.ts`), que ya había divergido en el
    logging. El timing y el logging por intento se preservan vía callback.
  - **H4 — Boilerplate de rutas (HOF/Decorator):** nuevo `src/lib/apiHandler.ts`
    (`apiOk`, `apiError`, `withAuth`, `withClientAuth`). Migradas como piloto
    `rubros/route.ts` y `coeficientes/route.ts`. Nota: los POST migrados ahora
    devuelven **500** (no 400) para errores no-Zod — el shape `{ ok, error }` se
    mantiene.
  - **H5 — `loadProcessingClient()` (Factory):** en `clientProcessingConfig.ts`.
    Reemplaza el `findUnique({ select })` + mapeo a `ProcessingClient` duplicado
    en 8 lugares (scan, invoices, invoices/[invoiceId], receipt, payments,
    payments/[paymentId], setup-sheet-protection, syncInvoicePayments); corrige
    los valores hardcodeados (`name`, `batchSize`, `intervalMinutes`).

### Features
- **Logs de métricas del pipeline (instrumentación para análisis) (2026-06-08)**.
  Una línea `[metrics] {JSON}` por boleta en el log del worker (additiva, greppable):
  tiempos por paso (`ms.ai/ocr/text/...`), tokens+modelo, `textSource`
  (direct/ocr/merged/image), método de match, `result` y `reason`. Núcleo siempre
  sin PII; el bloque `values` (extraído vs canónico) solo con `debugMode`. Solo
  logging, sin migración. Archivos: `pdfTextExtractor.service.ts`, `logger.ts`,
  `processPendingDocuments.job.ts`. Nuevo: `scripts/test-metrics-payload.ts`.
  Diseño: `docs/superpowers/specs/2026-06-08-logs-metricas-pipeline-design.md`.
- **Rendiciones por edificio: boletas y recibos organizados en Drive para QR (2026-06-07)**.
  Las boletas OK ya no van a "Escaneados": ahora se organizan en
  `Rendiciones/[Edificio]/[Período]/` dentro de una carpeta raíz pública
  (`driveFoldersJson.statements`) que crea el owner una vez. La app crea la
  subcarpeta de cada edificio, la **comparte pública** (anyone/reader) una sola
  vez y guarda su link en `Consortium.statementsFolderUrl` (visible en el panel,
  con botón **Copiar** → para generar el QR). Dentro, los períodos se agregan mes
  a mes (`2026-06 Junio`). Los PDFs se **renombran** con naming legible
  (`PROVEEDOR - CONSORCIO - P06-2026 - NNNN.pdf`; sin N° → `SN + 6 del hash`;
  recibos según el tipo de pago, junto a su boleta). Aplica al **pipeline** y a
  la **carga manual**. Los **duplicados** siguen yendo a Duplicados (no a
  Rendiciones). **Llave anti-tokens en el scheduler:** si falta la carpeta
  `statements` o no hay ningún período ACTIVE, el cliente se saltea con aviso y
  **no se gasta ningún token** (los PDFs quedan en Pendientes). Caso puntual: un
  consorcio sin período activo → su boleta va a Revisión (`failed`). Delete y
  purga ahora mueven el archivo desde su **parent real** (Rendiciones), no
  asumiendo Escaneados. Migración: `Consortium.statementsFolderId/Url`
  (`20260607000100`). Diseño en
  `docs/superpowers/specs/2026-06-05-rendiciones-por-edificio-design.md` y
  detalle en `docs/decisiones.md`. Archivos: `schema.prisma`, `client.types.ts`,
  `clientProcessingConfig.ts`, `googleDrive.service.ts`,
  `processPendingDocuments.job.ts`, `runProcessingCycle.ts`, `jobWorkerMain.ts`,
  `scheduler.ts`, `logger.ts`, `invoices/route.ts`,
  `invoices/[invoiceId]/receipt/route.ts`, `clients/[id]/purge/route.ts`,
  `admin/consortiums/page.tsx`. Nuevos: `src/lib/statementsNaming.ts`,
  `src/services/statementsFolders.service.ts`, `scripts/test-statements-naming.ts`.
- **Crear archivos en Drive con service account vía Unidad Compartida (2026-06-04)**.
  La carga manual del PDF fallaba con `Service Accounts do not have storage
  quota` (las SA no pueden crear archivos en "Mi unidad"). Solución: mover las
  carpetas del cliente a una **Unidad Compartida** con la SA como miembro
  (Administrador de contenido) — el código ya soportaba Shared Drives, sin
  cambios y sin migración (los IDs de carpeta no cambian al mover). Se agregó
  además **soporte opcional de domain-wide delegation** (`impersonateEmail` en
  `googleConfigJson` / env `GOOGLE_IMPERSONATE_EMAIL` → `subject` en el JWT),
  retrocompatible. MorinigoAdm: unidad "Control de Boletas y Pagos". Detalle en
  `docs/decisiones.md`. Archivos: `googleDrive.service.ts`, `client.types.ts`,
  `clientProcessingConfig.ts`, `config/env.ts`.
- **Duplicados: consistencia DB↔Sheets + carpeta opcional (2026-06-04)**.
  Hasta ahora el pipeline escribía las boletas duplicadas en Google Sheets
  (marcadas `isDuplicate=YES`) pero NO en la DB — por eso Sheets quedaba con
  más filas que la DB (en MorinigoAdm: 522 vs 499, exactamente los 22+1
  duplicados). Diagnóstico read-only confirmó que NO era un bug de inserción
  (la boleta reportada como "faltante" estaba en la última fila). A pedido,
  ahora **los duplicados ya no se escriben en Sheets** → la planilla y la DB
  se mantienen 1:1 hacia adelante. Además, si se configura
  `driveFoldersJson.duplicates`, el PDF duplicado se mueve a esa carpeta
  ("Duplicados") en vez de a Escaneados, para revisión. Lo ya registrado en
  Sheets NO se modifica (solo aplica de ahora en más).
  Se descartó persistir los duplicados en la DB porque choca con el unique
  `uq_invoice_business_key` (requeriría migración que debilita la integridad)
  y porque inflaría los totales del período. Detalle en `docs/decisiones.md`.
  Archivos: `processPendingDocuments.job.ts`, `runProcessingCycle.ts`,
  `jobWorkerMain.ts`, `clientProcessingConfig.ts`, `client.types.ts`.
  Nuevo: `scripts/diag-sheets-consistency.ts` (diagnóstico read-only).

- **Carga asistida: el PDF escaneado ahora se guarda en Drive (2026-06-02)**.
  Antes, el PDF que se sube al modal "Cargar boleta" solo se usaba para
  extraer datos con IA y se descartaba — la boleta quedaba sin `sourceFileUrl`
  (columna ARCHIVO en "—" y celda de URL vacía en Sheets). Ahora, si la carga
  trae PDF, el endpoint `POST /api/client/consortiums/[id]/invoices` lo sube a
  la carpeta `scanned` del cliente (fallback `receipts`), guarda
  `driveFileId` + `sourceFileUrl` en la Invoice y escribe la URL en la
  columna K de Sheets. El endpoint acepta `multipart/form-data` además de
  JSON (compat). Si Drive falla, la boleta se guarda igual y se informa vía
  `driveWarning`. Archivos: `route.ts`, `page.tsx`.

### Fixes
- **Carga manual ahora deduplica (no se pueden cargar boletas repetidas) (2026-06-05)**.
  Bug crítico: el endpoint de carga manual generaba el `documentHash` con
  `Date.now()` (único siempre → el candado de hash nunca detectaba el mismo
  PDF) y no verificaba business key. Resultado: el mismo PDF cargado 2 veces
  entraba 2 veces en DB y Sheets (agravado cuando la IA leía el N° distinto,
  ej. `0005-...` vs `00005-...`, lo que tampoco activaba el unique de business
  key). Fix: se computa el **hash real del binario** (`computeDocumentHash`,
  igual que el pipeline) y se verifica duplicado por **hash** y por **business
  key** ANTES de subir/guardar; si ya existe, corta con **409** y un mensaje
  claro ("Esta boleta ya fue cargada"). Archivo: `route.ts`.
- **Inserción en Sheets con `append`+INSERT_ROWS (filtros se expanden) (2026-06-05)**.
  `GoogleSheetsService.insertRow` calculaba la fila a mano (`values.get` +
  `update` en `length+1`). Eso escribía en una celda **fuera del rango del
  filtro** de la hoja, por lo que un filtro creado por el usuario no mostraba
  las filas nuevas (había que recrearlo). Reescrito con
  `spreadsheets.values.append` + `insertDataOption: INSERT_ROWS`: inserta una
  fila física dentro de la tabla → el filtro/rango se expande solo. Además es
  **atómico** (sin race conditions entre worker y carga manual) e inmune a
  "filas fantasma". Afecta pipeline y carga manual. Sin migración.
  Archivo: `googleSheets.service.ts`.
- **Carga manual: el campo `consortium` (texto) quedaba NULL (2026-06-05)**.
  El endpoint `POST .../invoices` seteaba `consortiumId` (FK, correcto) pero no
  copiaba el nombre al campo desnormalizado `consortium`, que quedaba en NULL
  (se veía como "boleta sin consorcio" en vistas que muestran el texto, aunque
  la relación estaba bien). Se agregó `consortium: consortium.rawName` al
  create. Registro histórico afectado corregido vía UPDATE puntual en DB.
  Nota: confirmado que el PDF SÍ se sube a Drive (Shared Drive) y la fila SÍ
  se escribe en Sheets — el reporte de "no está en Sheets" fue un falso
  negativo (fila al final de la hoja). Archivo: `route.ts`.
- **Fallo silencioso al escribir boleta manual en Sheets (2026-06-02)**. El
  insert a Google Sheets en la carga manual estaba envuelto en un `try/catch`
  que solo hacía `console.warn` — si fallaba, la boleta quedaba en la DB pero
  no en la planilla y el usuario no se enteraba. Ahora el endpoint devuelve
  `sheetsWarning` y la UI lo muestra como toast (o confirma el éxito).
  Archivos: `route.ts`, `page.tsx`.

### UI
- **Columna "Estado" → "Origen" (Manual / Automática) (2026-06-02)**. La
  columna mezclaba conceptos (Manual / Duplicado / OK). Ahora indica solo el
  medio de carga: **Manual** (cargada a mano) o **Automática** (procesada por
  el pipeline desde Drive). Archivo: `src/app/admin/consortiums/page.tsx`.
- **Modal "Cargar boleta": monto con separador de miles + nombre del
  consorcio destacado (2026-06-02)**. El input de Monto pasó de
  `type="number"` (sin separadores) a `type="text"` + `inputMode="decimal"`
  con formateo es-AR al perder foco (`721.571,37`). El valor autocompletado
  por el scan también se muestra ya formateado, y al guardar se parsea con
  `parseAmountInput` (maneja puntos de miles). El nombre del consorcio al
  que se carga la boleta ahora se muestra grande, centrado y en mayúscula
  (nueva clase `.modalConsortiumName`), con el período centrado debajo.
  Archivos: `src/app/admin/consortiums/page.tsx`, `page.module.css`.

### Fixes
- **Falsos positivos en "esta boleta no pertenece al consorcio" al cargar
  manualmente (2026-06-02)**. El endpoint de scan (`POST /api/client/
  consortiums/[id]/invoices/scan`) avisaba que la boleta no pertenecía al
  consorcio seleccionado aunque sí perteneciera — típicamente cuando la IA
  tomaba al **proveedor** como consorcio. La validación solo comparaba
  igualdad exacta del nombre normalizado, mientras que el pipeline real usa
  matching de 4 niveles. Ahora el scan reutiliza esa misma lógica robusta
  (**CUIT → exacto → fuzzy → alias/matchNames**) y solo declara mismatch
  cuando la boleta matchea **claramente con otro consorcio** del cliente; si
  no se puede determinar, no bloquea. Sin cambios de contrato ni migración.
  Detalle en `docs/decisiones.md` (entrada 2026-06-02).
  Archivo: `src/app/api/client/consortiums/[id]/invoices/scan/route.ts`.

### CI / Ops
- **Export de logs antes del rebuild + upload como artifact (2026-05-25)**.
  Nuevo step en el job `deploy` que ejecuta `scripts/export-logs.ps1`
  (ya existente) antes de `docker compose up --force-recreate`. Genera
  `logs/<timestamp>_<service>.txt` para web, worker y scheduler de las
  últimas 72h. El siguiente step usa `actions/upload-artifact@v4` para
  subir esos .txt como artifact (`docker-logs-<sha>`, retención 14d),
  así quedan accesibles desde la pestaña Actions del repo aunque el
  runner se reinicie o pisemos `logs/` en el próximo deploy.
  Best-effort (`continue-on-error: true`) — si no hay containers
  previos, el step pasa sin abortar el deploy.
  Archivo: `.github/workflows/ci.yml`.

### Features
- **Destino del archivo al eliminar boleta: `failed` (Revisión) en vez de
  `pending` (2026-05-25, corrección)**. El PDF iba originalmente a la
  carpeta `pending`, lo cual hacía que el scheduler lo re-procesara y
  creara la misma boleta de nuevo. La carpeta correcta es la que el
  schema llama `failed` y en Drive se muestra como "Revisión" (nombre
  más amigable que ya estaba en uso). Endpoint DELETE invoice ahora
  mueve a `folders.failed`; si el cliente no la tiene configurada, el
  archivo se deja donde estaba y la respuesta incluye `warning`.
  Archivos: `src/types/client.types.ts` (doc del campo `failed`),
  `src/app/api/client/consortiums/[id]/invoices/[invoiceId]/route.ts`.

- **Eliminación de boletas y pagos desde la UI (2026-05-25)**. Dos endpoints
  nuevos y dos controles inline (ícono 🗑 + confirm "¿Borrar? Sí/No"):
  - `DELETE /api/client/consortiums/[id]/invoices/[invoiceId]` — elimina
    una boleta. Validaciones: pertenece al cliente + 0 pagos asociados
    (si tiene → 409, hay que borrar los pagos antes). Efectos:
      - Mueve el PDF en Drive `scanned` → `pending` (fallback: la carpeta
        actual del archivo si no está en scanned ni unassigned). Si el
        archivo no estaba en una carpeta conocida, no se mueve.
      - Si la boleta tenía un `Receipt` asociado (recibo manual), manda
        el PDF a la papelera de Drive y borra la fila de Receipt.
      - Borra la fila completa en Sheets (`deleteDimension` — no la
        blanquea).
      - Borra el Invoice de DB en transacción con el Receipt.
    Atómico: Drive y Sheets se ejecutan antes que DB; si fallan, se aborta
    con HTTP 502 sin tocar DB.
  - `DELETE /api/client/invoices/[id]/payments/[paymentId]` — elimina un
    pago. Restricción: solo el último pago registrado (validación
    heredada del `PaymentRepository`). Efectos:
      - Si el pago tenía comprobante (`driveFileId`), lo manda a la
        papelera de Drive.
      - Actualiza Sheets cols N/P/Q/R/S/T/U: si quedan otros pagos
        escribe el resumen del más reciente, si no limpia las celdas y
        deja estado "Impago".
      - Borra el Payment de DB + recalcula `isPaid` y `remainingBalance`
        de la Invoice (transacción Prisma).
    NO revierte el `periodId` si la boleta fue reasignada al mes
    siguiente por pago parcial.
  - Servicios nuevos: `GoogleDriveService.trashFile(fileId)`,
    `GoogleDriveService.getFileParents(fileId)`,
    `GoogleSheetsService.findInvoiceRow(...)`,
    `GoogleSheetsService.deleteInvoiceRow(...)`.
  - UI: botón 🗑 con confirm inline (mismo patrón que LSP services).
    Boletas: nueva columna ACCIONES al final. Pagos: el 🗑 va al lado
    del botón Cuotas/Ver pagos en la columna ACCIONES existente, y solo
    aparece si la boleta tiene al menos un pago registrado. Toasts
    de feedback (`toolbarInfo` / `toolbarError`).
  Solo CLIENT puede invocar estos endpoints.
  Archivos: `src/services/googleDrive.service.ts`,
  `src/services/googleSheets.service.ts`,
  `src/app/api/client/consortiums/[id]/invoices/[invoiceId]/route.ts`
  (nuevo),
  `src/app/api/client/invoices/[id]/payments/[paymentId]/route.ts`
  (reescrito),
  `src/app/admin/consortiums/page.tsx`.

### UI / UX
- **Mensaje de error incluye N° de comprobante + input importe en formato
  es-AR (2026-05-25)**. El mensaje de validación de pagos inline ahora
  muestra `Proveedor – N°comprobante: falta X` (antes solo el proveedor).
  El input "IMPORTE PAGO" pasó de `type="number"` a `type="text"` con
  `inputMode="decimal"`. Placeholder formateado con `Intl.NumberFormat`
  es-AR (ej: "85.000,16"). Helper `parseAmountInput()` acepta ambos
  formatos al guardar (coma o punto decimal). Helper `formatAmountPlain()`
  para placeholders sin símbolo de moneda.
  Archivo: `src/app/admin/consortiums/page.tsx`.

- **Validación de campos requeridos al registrar pago (2026-05-25)**.
  Tanto el flujo inline como el modal exigen ahora fecha de pago, importe
  (salvo empleados, que se autocalcula), medio de pago y comprobante PDF.
  Si falta alguno, mensaje específico ("falta fecha de pago, comprobante
  PDF"). Inline acumula errores por fila ("Proveedor X: falta..."). Modal
  acumula todos los faltantes en un solo mensaje. Label "Comprobante PDF
  (opcional)" → "Comprobante PDF".
  Archivo: `src/app/admin/consortiums/page.tsx`.

- **Columna COMPROBANTE inline en Pagos (2026-05-25)**. Nueva columna
  entre MEDIO DE PAGO y ACCIONES con botón "📎 Adjuntar" para subir
  un PDF junto al pago inline (antes solo se podía adjuntar via el
  modal de Cuotas). `PendingPaymentInput` extendido con `file: File | null`
  y `handleGuardarPagos` arma FormData cuando hay archivo (mantiene
  JSON cuando no, para no romper el flujo existente).
  Archivo: `src/app/admin/consortiums/page.tsx`.

- **Label del período en mayúsculas (2026-05-25)**. `text-transform:
  uppercase` en `.periodNavLabel` ("Mayo 2026" → "MAYO 2026"). Archivo:
  `src/app/admin/consortiums/page.module.css`.

- **Espaciado de Pagos consistente con Boletas (2026-05-25)**. Removidos
  los `marginBottom: 12` inline del `statsStrip` y `searchRow` de
  PagosView — `.main` ya aporta `gap: 16px` entre hijos. Mismo ritmo
  vertical que Boletas. Archivo: `src/app/admin/consortiums/page.tsx`.

- **Header de Pagos con stat cards y "X de Y" en Pagos registrados
  (2026-05-25)**. El header de la pestaña Pagos pasó de
  `.pagosSummary` (spans inline) a `.statsStrip` + `.statCard` (mismo
  diseño de recuadros que Boletas). "Pagos registrados" ahora muestra
  `{pagadas} de {total}` (cantidad de boletas, no monto) — más
  intuitivo para saber cuántas faltan cobrar. "Saldo impago" mantiene
  el color naranja vía `.statWarn` cuando el valor es > 0.
  Archivo: `src/app/admin/consortiums/page.tsx`.

- **Totales del header desacoplados del filtro + cada stat en su propio
  recuadro (2026-05-25)**. Las métricas del header (Boletas, Total
  período, Duplicados en la pestaña Boletas; Pagos registrados y Saldo
  impago en Pagos) ahora se calculan sobre el período completo, no
  sobre el subset filtrado por el buscador. CSS: el `.statsStrip` dejó
  de ser un contenedor único — cada `.statCard` tiene su propio border
  y background, todos en una fila con `gap: 10px`.
  Archivos: `src/app/admin/consortiums/page.tsx`,
  `src/app/admin/consortiums/page.module.css`.

- **Medio de pago del modal: input libre → dropdown (2026-05-25)**.
  El campo "Medio de pago" del modal de cuotas pasó de `<input type=text>`
  a `<select>` con las mismas 3 opciones que el inline (Débito automático,
  Transferencia, Efectivo). Ambos selects usan placeholder "Elija una
  opción" (option vacía `disabled hidden`).
  Archivo: `src/app/admin/consortiums/page.tsx`.

- **Toggle del modal: "Pagar en cuotas" → "Cuotas fijas" (2026-05-25)**.
  Más claro respecto al modo (monto auto-calculado por N cuotas).
  Archivo: `src/app/admin/consortiums/page.tsx`.

- **Medios de pago simplificados + botón "Cuotas" (2026-05-25)**. En el
  dropdown de Medio de Pago de la pestaña Pagos quedan solo 3 opciones
  genéricas: Débito automático, Transferencia, Efectivo. Se sacaron las
  variantes con banco y "Descuento". El botón "Pagar" de la columna
  Acciones se renombró a "Cuotas" — abre el modal para pagos en cuotas
  (fijas o variables); los pagos únicos se cargan inline en la fila.
  Prop `consortiumBank` removida de PagosView (ya no se usa).
  Archivo: `src/app/admin/consortiums/page.tsx`.

- **Buscadores unificados — sin matching por detalle (2026-05-25)**.
  Boletas y Pagos ahora filtran por `provider + boletaNumber + CUIT` con
  el mismo placeholder. Se sacó el match por `detail` (poco usado y
  ruidoso). Archivo: `src/app/admin/consortiums/page.tsx`.

- **Scroll vertical en tablas con header sticky (2026-05-25)**. `.tableWrap`
  ahora tiene `max-height: 65vh` y `overflow: auto`; el `<thead>` queda
  pegado arriba al scrollear. Aplica a Boletas, Pagos y "Ver pagos".
  Archivo: `src/app/admin/consortiums/page.module.css`.

- **Stats inline en una sola línea (2026-05-25)**. Las 4 stat cards de
  la pestaña Boletas (Boletas, Total período, Duplicados, Rubros) estaban
  en un grid 4×1 con cada card grande (label arriba 11px, valor abajo
  22px), ocupando ~80px verticales. Ahora viven en una sola barra
  horizontal compacta (`.statsStrip` pasó de `display: grid` a
  `display: flex; flex-wrap: wrap`) con label y valor inline en baseline.
  Cada item es `.statCard` con `display: inline-flex; gap: 8px` (label +
  valor). El contenedor mantiene `background` y `border-radius`. En
  mobile (`max-width: 768px`) reduce gap y padding; ya no hace falta
  cambiar el grid-template-columns. Total: ~50px menos de altura.
  Archivos: `src/app/admin/consortiums/page.module.css`.

- **Buscador en pestaña Pagos (2026-05-25)**. La pestaña Boletas tenía
  un input de búsqueda (proveedor / N° boleta / detalle), Pagos no. Se
  agregó el mismo widget (`.searchRow` + `.searchInput` + `.clearSearch`)
  en PagosView con state local `search` independiente del de Boletas
  (cada pestaña tiene su contexto de búsqueda). Filtra por nombre de
  proveedor y N° de comprobante. Empty state diferenciado: "No hay
  boletas que coincidan con la búsqueda" vs "No hay boletas para este
  período". Los totales del header (Pagos registrados, Saldo impago)
  se calculan sobre el subset filtrado — útil para ver el saldo que
  debe un proveedor específico al buscarlo.
  Archivos: `src/app/admin/consortiums/page.tsx`.

- **Navegador de período al lado del nombre del consorcio (2026-05-25)**.
  El bloque `‹ Mes Año ›` vivía debajo de la sección de Servicios públicos
  (LSP), forzando un scroll para cambiar de período. Se movió al
  `detailHeader`, inline al lado del título del consorcio, dentro de una
  nueva fila `.detailTitleRow` (flex con gap 18px, wrap habilitado para
  pantallas chicas). Ahora cambiar de mes es 1 click sin scroll.
  Archivos: `src/app/admin/consortiums/page.tsx`,
  `src/app/admin/consortiums/page.module.css`.

- **Sección Servicios públicos (LSP) colapsable (2026-05-25)**. El bloque
  ocupaba ~5 renglones fijos (título + tabla + formulario de alta) en
  todos los consorcios, aunque la mayoría del tiempo no se necesita
  interactuar (los servicios ya están cargados desde el archivo ALTA).
  Ahora el `<h3>` es un botón toggle (`.lspToggle`) con chevron `▸/▾` y
  badge contador con la cantidad de servicios. **Default cerrado** —
  el usuario expande on-demand para ver, agregar o eliminar. El form de
  alta también queda oculto hasta expandir, lo cual evita clicks
  accidentales. Estado local `lspCollapsed` (session-only).
  Archivos: `src/app/admin/consortiums/page.tsx`,
  `src/app/admin/consortiums/page.module.css`.

- **Eliminación del toolbar superior en /admin/consortiums (2026-05-25)**.
  Se quitó por completo el `<div className={styles.toolbar}>` que ocupaba
  una franja horizontal arriba del contenido principal. Antes contenía:
  hamburger (mobile), mensajes de feedback (toolbarInfo/toolbarError) y
  toggle de tema (sol/luna). Tras las iteraciones previas (botones del
  scheduler movidos al sidebar), el toolbar quedó casi vacío y solo
  comía altura útil de la tabla. Lo que se hizo con cada elemento:
  - **Toggle de tema**: eliminado. El cambio de tema vive solo en el
    panel principal (`/admin`), que ya tiene su propio botón "Modo
    claro/oscuro". Al cargar `/admin/consortiums` se respeta el
    `data-theme` que haya dejado el panel principal (lectura del
    atributo en `document.documentElement` al mount).
  - **Hamburger menu** (`☰`): reubicado como **botón flotante**
    (`position: fixed`, top-left) en una nueva clase `.fabHamburger`,
    visible solo en `max-width: 1024px`. En desktop el sidebar
    izquierdo siempre está visible, así que no hace falta.
  - **Mensajes de feedback**: convertidos en **toast flotante**
    arriba-derecha (`.toastContainer` + `.toastItem`) con
    autodismiss (4s info, 5s error) y animación slide-in. Antes los
    mensajes quedaban pegados en el toolbar hasta la próxima acción.
  Archivos: `src/app/admin/consortiums/page.tsx`,
  `src/app/admin/consortiums/page.module.css`.

- **Fix NaN + simplificación de headers en pestaña Pagos (2026-05-25)**.
  Los totales del header (Total del período / Pagos del mes actual /
  Saldo impago) mostraban `$ NaN` porque Prisma serializa `Decimal` como
  string y `string + 0` concatena en vez de sumar — el `reduce` armaba
  `"65000.2665000.08…"` y `Intl.format` no podía parsearlo. Se agregó un
  helper `toNum()` que convierte explícitamente (con guarda `isFinite`)
  y se recalcularon las métricas con semántica correcta:
  - **Pagos registrados** = `amount - remainingBalance` por boleta
    (refleja pagos parciales reales, antes simplemente sumaba `amount`
    de las boletas marcadas `isPaid`, lo cual ignoraba pagos en cuotas).
  - **Saldo impago del período** = suma de `remainingBalance` (o
    `amount` si nunca se pagó nada) de las boletas no pagadas.

  Además se eliminó la métrica "Total del período" porque era redundante
  con la stat card "TOTAL PERÍODO" de la pestaña Boletas. Se renombró
  "Pagos del mes actual" → "Pagos registrados" (más preciso: cuenta
  pagos del período seleccionado, no del mes calendario).
  Archivos: `src/app/admin/consortiums/page.tsx`.

- **Botones del scheduler movidos del toolbar al sidebar (2026-05-25)**.
  Los botones "Pausar scheduler" / "Encender scheduler" y "Ejecutar ahora"
  vivían en el toolbar superior, ocupando espacio visual encima de la
  tabla principal. Se movieron al sidebar colapsable izquierdo, agrupados
  arriba del botón "Cerrar sesión" y separados por un divisor. El toolbar
  ahora solo conserva el hamburger menu (mobile) y los mensajes de
  feedback (toolbarInfo / toolbarError). Mantienen los mismos handlers
  (`handleToggleScheduler`, `handleRunNow`) y reaccionan al mismo estado
  (`paused`, `schedulerEnabled`, `busyAction`). Iconos: ⏸️/▶️ para el
  toggle y ⚡ para ejecutar ahora.
  Archivos: `src/app/admin/consortiums/page.tsx`.

- **Separación de responsabilidades entre pestañas Boletas y Pagos
  (2026-05-25)**. La tabla de la pestaña **Boletas** ya no muestra los
  botones "Pagar" / "Ver pagos" en la columna PAGO — solo conserva el
  indicador visual de estado (`Pagada` / `Resta $X` / `—`). Los botones
  de acción se movieron a una nueva columna **ACCIONES** al final de la
  tabla de la pestaña **Pagos**, donde conviven con el flujo inline
  existente (carga rápida fecha/importe/medio + botón GUARDAR al pie).
  Motivo: el botón duplicado en Boletas generaba confusión sobre dónde
  cargar pagos. Ahora cada pestaña tiene una sola responsabilidad clara:
  Boletas = datos de boletas, Pagos = gestión de pagos. Los modales
  (cuotas/libre y "Ver pagos") siguen activos, solo cambia el entry
  point. Archivos: `src/app/admin/consortiums/page.tsx`.

### Security / CI
- **Healthcheck real con verificación de DB (2026-05-25)**. Nuevo endpoint
  `GET /api/health` que ejecuta `prisma.$queryRaw\`SELECT 1\`` con timeout
  de 5s y devuelve 503 si la DB no responde. El healthcheck de
  `docker-compose.yml` ahora apunta a `/api/health` en vez de `/login`.
  Antes, el healthcheck del container marcaba "healthy" aunque la conexión
  a Supabase estuviera caída (porque `/login` es un form estático que pasa
  igual). Ahora un fallo real de DB → Docker marca unhealthy → restart
  automático según `restart: unless-stopped`. Response incluye `uptime`,
  `timestamp` y `message` con el error si aplica. El endpoint es público
  (sin auth) — el middleware solo matchea `/admin*` y `/login`.
- **Límites de memoria y CPU en docker-compose.yml (2026-05-25)**.
  Agregadas declaraciones `deploy.resources.limits` y `reservations` a los
  4 servicios para prevenir que un memory leak en el worker o spike de
  carga tire el host completo (escenario crítico porque el host también
  corre el self-hosted runner de GHA — un OOM bloqueaba futuros deploys).
  Valores elegidos basados en el rol de cada servicio:
  - **web** (Next.js SSR): limit 1024M / 1 CPU, reservation 256M / 0.25 CPU.
  - **scheduler** (escaneo periódico de Drive): limit 256M / 0.5 CPU,
    reservation 64M / 0.1 CPU. Es el más liviano.
  - **worker** (OCR + IA + pdf-parse): limit 1536M / 2 CPU, reservation
    512M / 0.5 CPU. El más pesado, picos altos con PDFs grandes.
  - **tunnel** (cloudflared): limit 128M / 0.25 CPU. Daemon liviano.

  Las `reservations` se ignoran en Docker Compose standalone (solo aplican
  en Swarm) pero documentan el baseline esperado. Los `limits` sí se
  aplican y previenen OOM del host.

- **`.dockerignore` ampliado (2026-05-25)**. El archivo tenía solo 8
  patrones básicos. Ahora cubre 41 patrones organizados por categoría:
  - **Build outputs:** `dist/`, `*.tsbuildinfo` (se regeneran en el
    builder con `npm run build:jobs`).
  - **Logs locales:** `logs/`, `*.log`, debug logs de npm/yarn/pnpm.
  - **Variables de entorno:** ampliado a `.env` y `.env.*` (antes
    `.env*`, equivalente pero más explícito).
  - **IDEs y herramientas locales:** `.vscode`, `.idea`, `.claude`,
    `.cursor`, `*.swp`/`*.swo`.
  - **Sistema operativo:** `Thumbs.db`, `.DS_Store`.
  - **Documentación interna:** `docs/`, `CHANGELOG.md`, `README.md`,
    `CLAUDE.md`, `*.pdf` — no se necesitan en runtime. No reducen el
    tamaño de la imagen final (el runner stage solo copia
    `.next/standalone`, `public`, `dist`, `prisma` desde el builder),
    pero aceleran el envío del contexto al daemon y evitan filtrar
    docs internas en stages intermedias.
  - **CI/CD:** `.github/` (los workflows no van adentro del container).
  - **Tests y caches:** `coverage/`, `*.test.*`, `*.spec.*`,
    `__tests__`, `.eslintcache`.
  - **Backups:** `*.bak`, `*.orig`, `*.tmp`.

  Verificado contra el Dockerfile: el `COPY . .` del builder sigue
  recibiendo todos los paths necesarios para `npx prisma generate &&
  npm run build && npm run build:jobs` (src, prisma, public,
  package.json, tsconfig*, next.config.ts, middleware.ts,
  next-env.d.ts). `scripts/` queda incluido porque puede usarse con
  `docker exec` para tareas admin (create-admin, fix-folders, etc.).

  Impacto medido del contexto excluido: ~2.1 MB adicionales (logs 680 KB,
  tsbuildinfo ~672 KB, dist 399 KB, docs 180 KB, CHANGELOG/README/CLAUDE.md
  ~110 KB, .pdf 44 KB, .claude/.vscode 5 KB). Los exclusiones preexistentes
  ya cubrían 1.5 GB (`node_modules` 1.2 GB + `.next/` 322 MB). El beneficio
  principal de esta iteración no es el tamaño sino la defensa en profundidad
  contra leak de docs internas en stages intermedias.

- **Fix: `docker login` con action oficial (2026-05-21)**. El intento
  anterior usaba `$env:GHCR_TOKEN | docker login --password-stdin` en
  PowerShell. Falló en CI run #53 con `denied: denied`. Causa: PowerShell
  5.1 con `Write-Output`/`|` agrega CRLF al final del string pipeado;
  `docker login --password-stdin` lee hasta EOF e interpreta el token
  como `<token>\r\n`, que GHCR rechaza. Reemplazado por la action oficial
  `docker/login-action@v3` (misma que ya usa el job `build`) que
  internamente maneja el password-stdin correctamente en
  Linux/macOS/Windows. Mantiene el beneficio de Crítica #2 (token nunca
  como argumento visible).
- **Fix: scripts del job `deploy` reescritos en PowerShell (2026-05-21)**.
  El primer intento de los 3 fixes críticos (commit anterior) usaba
  `shell: bash`, pero el runner self-hosted Windows no tiene
  `/bin/bash` instalado — el step "Write env file" murió con
  `execvpe(/bin/bash) failed: No such file or directory`. Reescritos en
  `shell: powershell` (Windows PowerShell 5.1, mismo que ya usa el step
  "Wait for healthy (Windows)" del workflow):
  - **Crítica #1 — abort on failure:** PowerShell con
    `$ErrorActionPreference = 'Stop'` solo aborta en cmdlets, no en
    native commands (`docker`, `npx`). Para cubrir esos casos se
    definió un helper `Invoke-Step "<name>" { <body> }` que ejecuta el
    bloque y hace `throw` si `$LASTEXITCODE -ne 0`. Equivalente
    funcional a `set -euo pipefail` para native commands. Cada paso
    (login, pull, tag, migrate, up, prune) está envuelto en
    `Invoke-Step` con label legible que aparece en los logs como
    `==> prisma migrate deploy`.
  - **Crítica #2 — `--password-stdin`:** sin cambios funcionales,
    `$env:GHCR_TOKEN | docker login --password-stdin` funciona idéntico
    al pipe de bash.
  - **Crítica #3 — `.env` desde GitHub Secret:** validación con
    `[string]::IsNullOrWhiteSpace($env:PROD_ENV)`. Escritura con
    `[System.IO.File]::WriteAllText("$PWD\.env", $env:PROD_ENV)` para
    evitar el BOM UTF-16 que Windows PowerShell agregaría con
    `Out-File`/`Set-Content` por defecto (docker compose no parsea bien
    `.env` con BOM). `chmod 600` eliminado — no aplica en NTFS.
- **Hardening del workflow de deploy (2026-05-21)**. Tres fixes críticos
  aplicados a `.github/workflows/ci.yml`, job `deploy`:
  - **`set -euo pipefail`** al inicio de los scripts `run: |` (steps
    "Write env file" y "Build and restart"). Sin esto, un `prisma migrate
    deploy` fallido **no abortaba el script** — los pasos siguientes
    (`docker compose up -d --force-recreate`) seguían ejecutándose y los
    containers nuevos arrancaban con código nuevo contra schema viejo de
    DB. Era una falla silenciosa: el job de GHA reportaba ✅ pero
    producción quedaba rota. Con `-e` el script aborta inmediatamente,
    los containers viejos siguen corriendo, y el job reporta ❌
    explícitamente.
  - **`docker login --password-stdin`** en vez de `-p $TOKEN`. El token
    ya no aparece como argumento de proceso (visible en `ps aux`,
    `/proc/<pid>/cmdline`, warnings de Docker). Llega vía pipe desde la
    env var `GHCR_TOKEN`. Defense in depth — los scanners de seguridad
    flagean el patrón `-p` como CWE-214.
  - **`.env` desde GitHub Secret `PROD_ENV_FILE`** en vez de
    `copy` desde un path hardcodeado del runner
    (`C:\Users\jony\...\drive-doc-processor\.env`). El path apuntaba a
    una carpeta de un proyecto distinto al actual y solo funcionaba en
    una máquina. Ahora el contenido del `.env` vive en GitHub Secrets
    (cifrado at rest, enmascarado en logs), es editable desde la UI de
    GitHub, y funciona desde cualquier runner. Si el secret no está
    configurado, el job falla con error explícito en vez de seguir con
    `.env` faltante.

  **Migración manual requerida:** crear el secret `PROD_ENV_FILE` en
  `Settings → Secrets and variables → Actions` con el contenido completo
  del `.env` de producción antes del próximo push a master.

### Added
- **Feature: Pagos vía Sheets + modal UI con upload de PDF (2026-05-21)**.
  Sistema híbrido para registrar pagos sobre la misma fila de la boleta en la
  hoja de Sheets. Dos caminos de entrada complementarios:

  **Camino A — Modal en la UI:**
  - Botón **Pagar** en cada fila de la tabla de Boletas del panel cliente
    (`/admin/consortiums`). Cuando `isPaid === true`, el botón cambia a
    **Ver pagos** y abre un modal read-only con el historial completo
    (tabla con tipo, fecha, monto, medio, link comprobante, observación).
  - Modal con detección automática de **dos modos de pago** (consistente
    con `PaymentRepository`):
    - **Modo A — Cuotas pactadas:** el primer pago define `totalInstallments`.
      El backend calcula `effectiveAmount = invoice.amount / totalInstallments`
      con `installmentNumber` autoincrementando desde 1. El último pago
      absorbe la diferencia de redondeo (`remainingBalance` real).
    - **Modo B — Pago libre:** sin `totalInstallments`. El usuario decide el
      monto cada vez. `installmentNumber = null` siempre.
    - Mezcla bloqueada: si la boleta arrancó libre, no se pueden agregar
      cuotas; si arrancó en cuotas, no se pueden agregar pagos libres.
      `PaymentRepository` lanza 409 si se intenta.
  - Comportamiento del modal:
    - **Primer pago:** muestra un toggle "Pago libre / Pagar en cuotas".
      Si elige cuotas, aparece el input "cantidad de cuotas" y el monto
      se autocalcula y se muestra como readonly.
    - **Pagos siguientes (cuotas pactadas):** banner azul "Modo cuotas
      pactadas · Cuota N de M". Input cuotas oculto, monto autocalculado y
      readonly. Aviso "Última cuota — absorbe diferencias de redondeo" en la
      cuota final.
    - **Pagos siguientes (libre):** banner naranja "Modo pago libre · Ya hay
      N pago(s) registrado(s)". Input cuotas oculto, monto editable con
      default = `remainingBalance`.
  - Resto de campos: fecha, medio de pago (texto libre), observación
    (opcional), archivo PDF (opcional, máx 20MB).
  - El endpoint `POST /api/client/invoices/[id]/payments` ahora acepta
    `multipart/form-data` además de JSON (compatible con la UI legacy):
    sube el PDF a Drive (carpeta `receipts / consorcio / período`), crea el
    Payment vía `PaymentRepository`, reasigna `periodId` al mes siguiente
    si queda saldo (crea período ACTIVE si no existe) y refleja todo en la
    fila de Sheets en una sola pasada (batch update sobre N/P/Q/R/S/T/M).

  **Camino B — Sincronización Sheets → DB:**
  - Endpoint `POST /api/client/sync-payments`: lee las columnas Q/R/S/T de
    cada fila de la hoja de boletas, hace upsert idempotente en `Payment`
    (clave natural: `invoiceId + día de pago + monto.toFixed(2)`), recalcula
    `isPaid` / `remainingBalance`, reasigna `periodId` al mes siguiente
    cuando queda saldo, y refleja los derivados (N/P/M) en la misma fila.
    Tolerante a errores — devuelve warnings por fila.
  - Útil cuando el cliente edita las columnas Q/R/S/T directamente en
    Sheets (sin pasar por el modal). Las dos vías son intercambiables.
  - Botón **Sincronizar pagos** (💵) en el sidebar del panel cliente.

  **Columnas nuevas en la hoja de boletas (escritas por la app):**
  - **P = SALDO PENDIENTE** — saldo restante formateado en es-AR.
  - **Q = MONTO PAGADO** — total acumulado pagado (derivado de
    `amount - remainingBalance`).
  - **R = CANT CUOTAS** — número total de cuotas si es pago en cuotas.
  - **S = FECHA PAGO** — fecha del último pago en formato DD/MM/YYYY.
  - **T = URL COMPROBANTE** — link al PDF subido a Drive.
  - **U = MEDIO PAGO** — texto libre con el medio de pago real usado
    (ej: "Transferencia BBVA", "Cheque 1234", "Efectivo"). Lo escribe el
    modal desde el campo `paymentMethod` del form, o el cliente directamente
    en Sheets. La key del mapping es `paidWith` para no colisionar con
    `Invoice.paymentMethod` (enum LSP extraído por la IA al procesar la
    factura).

  **Protección de la hoja (toggle bloqueo/desbloqueo manual):**
  - `POST /api/client/setup-sheet-protection`: aplica `addProtectedRange`
    sobre A:U de la hoja de boletas (rango calculado dinámicamente desde el
    mapping). La service account queda como único editor explícito.
    Idempotente: limpia rangos previos con descripción `dpp:invoices-lock`
    antes de crear el nuevo. **Antes de proteger ejecuta auto-sync** vía
    `syncInvoicePaymentsFromSheets` para volcar a la DB cualquier edición
    manual hecha mientras la hoja estaba desbloqueada. Si el sync falla, no
    se aplica la protección (devuelve error).
  - `DELETE /api/client/setup-sheet-protection`: quita los rangos
    `dpp:invoices-lock` para permitir ediciones manuales en Sheets en casos
    puntuales. Idempotente (responde ok aunque no hubiera ninguno). Solo
    CLIENT — el cliente es dueño de su propia hoja.
  - UI: botones **🔒 Proteger hoja** y **🔓 Desproteger hoja** en el sidebar
    (solo CLIENT). El de desproteger muestra una confirmación recordando
    que hay que re-bloquear cuando se termine — el re-bloqueo dispara el
    auto-sync.
  - Lógica del sync extraída a
    `src/lib/syncInvoicePayments.ts::syncInvoicePaymentsFromSheets` para
    ser reusable entre `/sync-payments` y `/setup-sheet-protection` (DRY).

  **Schema:**
  - `SchedulerState.lastPaymentsSyncAt DateTime?` — última sincronización.
  - **No se persiste `paidAmount` en Invoice**: es un derivado de
    `amount - remainingBalance` (o `SUM(payments.amount)` directo).
    Persistirlo crearía una tercera fuente de verdad que puede
    desincronizarse si alguien crea/elimina un Payment fuera del camino
    del recálculo.
  - Migración: `20260521000100_add_payment_sync_fields`.

  **Otros:**
  - El panel `/admin` muestra "Última sync pagos" junto a "Última sync
    directorio" en la tarjeta de estado del scheduler.
  - `GoogleSheetsService` extendido con `readInvoicePaymentRows`,
    `updateInvoicePaymentInfo` (escribe N/P/M/Q/R/S/T opcionalmente),
    `protectInvoiceColumns` y `getSheetId`.
  - El método `updatePaymentStatus` legacy se mantiene por compat con
    flujos existentes pero el path nuevo usa `updateInvoicePaymentInfo`.

### Changed
- CI/CD: el job `deploy` ahora pinea la imagen de Docker por `${{ github.sha }}`
  en vez de pullear `:latest`. `docker-compose.yml` lee el tag via
  `${IMAGE_TAG:-latest}`. Esto evita que un manifest local cacheado de `:latest`
  deje al host corriendo una imagen vieja después de un pull silenciosamente
  exitoso pero sin actualizar (caso que ocurrió el 18/05/2026 con el commit
  d33ff62). El step también retagea localmente a `:latest` después del pull
  para preservar el flujo de `docker compose up` manual sin la env var.

### Added
- Feature: soporte para Claude (Anthropic) como tercer proveedor de IA en la
  cadena de extracción. La cascada queda **Gemini → OpenAI → Claude** antes
  del fallback final a OCR_ONLY. Se aplica tanto en el pipeline automático
  (`processPendingDocuments.job.ts`) como en el endpoint de scan manual
  (`/api/client/consortiums/[id]/invoices/scan`).
  - Nuevo `ClaudeExtractorService` (`src/services/claudeExtractor.service.ts`)
    usando `@anthropic-ai/sdk` con `messages.create`, espejo del patrón de
    `AiExtractorService` (OpenAI): mismos prompts via `buildExtractionPrompt`
    y refinamiento posterior con `refineExtractionWithRawText`.
  - Tracking de tokens con `provider: "anthropic"` en `AiUsageMetrics`
    (`AiProvider` extendido a `"gemini" | "openai" | "anthropic"`).
  - Variables de entorno opcionales: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`
    (default `claude-haiku-4-5-20251001`).
  - `resolveAiConfig` desencripta `anthropicApiKey` por cliente igual que
    Gemini/OpenAI; `extractionConfigJson` admite `anthropicApiKey`/
    `anthropicModel` sin cambios de schema (JSON libre).
- Feature: `anthropicApiKey` configurable desde la UI admin (alta y edición
  de cliente), siguiendo el mismo patrón que `geminiApiKey`/`openaiApiKey`.
  - `GET /api/admin/clients/[id]` retorna `hasAnthropicApiKey`.
  - `PATCH /api/admin/clients/[id]` y `POST /api/admin/clients` validan y
    encriptan la key con `encrypt()` antes de persistir.
  - Inputs nuevos en `/admin/clients/[id]` (sección "Claves de IA") y en
    `/admin` (formulario de alta de cliente).
- CI: la imagen de Docker en `ghcr.io/johnydeev/ia-drive-doc-processor` ahora
  se tagea con `:latest` y con `${{ github.sha }}` en cada push a master,
  habilitando rollbacks a versiones anteriores por SHA.
- Feature: reporte de resumen al final de cada ciclo automático del
  scheduler, solo cuando se encontró al menos 1 archivo.
  Muestra encontrados, encolados y ya en cola.
- Feature: resumen de ciclo en worker automático — cuando la cola
  se vacía después de procesar al menos 1 archivo, emite totales
  de procesados, sin asignar, duplicados y fallidos.

## [Unreleased] - 2026-04-15

### Security
- Fix crítico: descifrado legacy ahora prueba ambas claves candidatas (GCEK + SESSION_SECRET)
  con AES-GCM auth-tag check, garantizando lectura de secretos viejos sin importar con cuál
  se cifraron originalmente
- Fix alto: removidos logs sin sanitizar — `pdf-extractor` ya no imprime los primeros 500
  chars del texto, y `extractionResult` redacta CUIT/CUITs/monto en logs normales
- Fix alto: scan rutea correctamente imágenes JPG/PNG a Gemini Vision en vez de pdf-parse
- Fix crítico: /api/process ahora requiere sesión de admin autenticada
- Fix alto: endpoints de escritura usan requireClientSession() — VIEWER no puede mutar datos
- Fix alto: scan (`POST /api/client/consortiums/[id]/invoices/scan`) usa requireClientSession — VIEWER no puede consumir IA/OCR
- Fix medio: límites de tamaño en uploads (Excel 10MB, PDF scan 15MB, receipt 20MB) + validación MIME
- Fix medio: validación de magic bytes en uploads (PDF, PNG, JPG, XLSX/ZIP)
- Fix medio: cifrado versionado v2 en `enc:v2:...`. Nuevos secretos usan exclusivamente
  GOOGLE_CREDENTIALS_ENCRYPTION_KEY; el formato legado `enc:...` sigue legible con SESSION_SECRET
  para compatibilidad. Script de migración: `tsx scripts/rotate-encrypted-secrets.ts [--apply]`
- Fix medio: validación en producción que avisa si falta GOOGLE_CREDENTIALS_ENCRYPTION_KEY
- Fix medio: sanitización (CUITs, importes, emails, CBU) + truncado de logs en debug mode
- Fix bajo: warning en logs cuando debug mode está activo con datos sensibles
- Fix bajo: OpenAPI documenta /api/process como protegido (cookieAuth)

### Fixed
- Fix: `clientNumber` se limpia automáticamente para boletas no-LSP si Gemini alucina un valor (campo reservado exclusivamente para boletas LSP)
- Fix deduplicación: `boletaNumber` distinto → nunca duplicado, independiente de monto y vencimiento. Caso testigo: dos facturas RANKO S.R.L. con números 0003-00154753 y 0003-00155282 se marcaban como duplicado por compartir monto/período.
- Fix: los duplicados no se guardan en DB — solo se registran en Sheets (con `ES_DUPLICADO=YES`) y se mueven a Escaneados.

### Added
- Feature: solapa Pagos en vista de consorcio
  - Tabs Boletas / Pagos en el header del consorcio (reset a "boletas" al cambiar de consorcio)
  - Vista Pagos con tabla inline editable (fecha, importe, medio de pago)
  - Empleados: solo fecha de pago (monto siempre total)
  - Proveedores: fecha + importe editable + medio de pago
  - Botón GUARDAR confirma todos los pagos pendientes en un solo click
  - Al guardar: actualiza `isPaid`/`remainingBalance` en DB y reescribe columna N ("ESTADO PAGO") en Sheets
  - Medios de pago: Transferencia/Cheque propio con banco del consorcio, Descuento, Efectivo
- Migración `20260415000200_payment_optional_drive_add_payment_method`: `Payment.driveFileId`/`driveFileUrl` ahora opcionales, nuevo campo `Payment.paymentMethod` (texto libre)
- `GoogleSheetsService.updatePaymentStatus()`: busca fila por `sourceFileUrl` o `boletaNumber+providerTaxId` y actualiza la columna `paymentStatus`
- Feature: soporte para archivos JPG/PNG en carpeta Pendientes de Drive. El scheduler los detecta y el pipeline los procesa directamente con Gemini Vision sin pasar por pdf-parse ni Tesseract OCR.
  - GoogleDriveService: query mimeType ampliado a image/jpeg e image/png
  - GeminiExtractorService: nuevo método `extractStructuredDataFromImage()`
  - Pipeline: detección `isImage` por mimeType/extensión, rama de procesamiento visual
  - ProcessDriveFileInput: nuevo campo `mimeType` opcional
- Feature: soporte para empleados de consorcio como tipo de proveedor
  - Nuevo enum `ProviderType` (PROVEEDOR / EMPLEADO) en tabla Provider
  - Sync-directory lee columna TIPO de hoja `_Proveedores` (5ta columna)
  - Nuevo prompt `buildReciboHaberesPrompt` para recibos de haberes
  - Router `isReciboHaberes()` detecta recibos por keywords antes del router LSP
  - UI: badge `[EMPLEADO]` en select de proveedores, etiqueta CUIL/CUIT según tipo
  - `amount` extrae NETO A COBRAR en recibos de haberes
  - Migración: `20260415000100_add_provider_type`

---

## [Unreleased] - 2026-04-14

### Added
- Feature: fallback visual con Gemini Vision para facturas donde el CUIT del emisor está en imagen. Se activa SOLO como último recurso cuando el proveedor no fue encontrado por CUIT ni nombre y hasEmitterBlock=false.

---

## [Unreleased] - 2026-04-09

### Added
- Feature: toggle "Modo Debug" por cliente en panel admin. Activa logs detallados de OCR e IA en el pipeline para diagnóstico
- Script `export-logs.ps1` para exportar logs de Docker a archivos locales con fecha
- Configuración de rotación de logs en docker-compose.yml (json-file, 50MB x 10)
- Lock de archivo vía carpeta "Procesando" en Drive: tras descargar, el pipeline mueve el archivo a la carpeta `processing` configurada en `driveFoldersJson.processing` (opcional). Si otro ciclo concurrente escanea Pendientes no lo vuelve a tomar. Los movimientos finales (Escaneados / Sin Asignar / Fallidos) usan Procesando como origen cuando el lock está activo.

### Fixed
- Fix buildInvoicePrompt: regla consortium reforzada para evitar confusión emisor/receptor en facturas donde ambos bloques tienen etiquetas similares
- Fix sync-directory: providerId se resuelve automáticamente al sincronizar LspServices (campo providerName texto se mantiene, providerId es complementario)
- Rename `LspService.provider` → `providerName` (claridad vs providerId FK)
- Fix LSP lookup: mapa router→canonicalName resuelve mismatch PERSONAL/TELECOM ARGENTINA S.A.
- Fix LSP fast path: providerId y providerTaxId ahora se asignan correctamente en Invoices de boletas LSP
- Fix race condition entre ciclos concurrentes (manual + scheduler) que causaba doble procesamiento del mismo archivo
- Fix sync-directory: timeout de transacción Prisma aumentado a 120s para evitar expiración con lotes grandes de proveedores/consorcios

### Changed
- Fix clientNumber LSP: normalización extendida elimina espacios internos antes del lookup (resuelve lspServiceId NULL en facturas Edenor y similares)
- Boletas LSP con clientNumber no registrado en LspService ahora van a Sin Asignar en lugar de procesarse sin vínculo
- Rename `Consortium.banco` → `bank`, `claveSuterh` → `suterhKey` (convención camelCase inglés)

---

## [Unreleased] - 2026-04-07

### Added
- Columna "ESTADO PAGO" en Google Sheets (columna N), valor inicial "Sin pagar" al insertar boleta
- Campos `banco` y `claveSuterh` en modelo Consortium
- Columna "BANCO" en Google Sheets (columna O)

---

## [Unreleased] - 2026-04-04

### Changed
- Layout refactorizado a 3 columnas independientes: navSidebar | lista consorcios | contenido
- Edicion de matchNames movida a modal de configuracion (boton "Configuracion" en detailActions)
- Boton "Cerrar sesion" reubicado al fondo del navSidebar con spacer flex

### Fixed
- Sidebar de navegacion y lista de consorcios unificados en columna izquierda unica
- Boletas del periodo ahora se renderizan correctamente en la tabla
- Monto total del periodo corregido (suma en lugar de concatenacion de Decimals)
- Boletas LSP integradas en tabla principal con badge identificador
- Toggle dark/light ahora aplica el tema correctamente al documento
- Fix build CSS Modules: variables de tema movidas a globals.css

---

## [Unreleased] - 2026-04-02

### Added
- Sistema de pagos parciales: tabla `Payment` con soporte para cuotas pactadas y pagos libres
- Campos `isPaid` y `remainingBalance` en Invoice
- Endpoints GET/POST `/api/client/invoices/[id]/payments` y DELETE `.../[paymentId]`

### Removed
- Campos `receiptDriveFileId` y `receiptDriveFileUrl` de Invoice (reemplazados por `Payment.driveFileId`/`driveFileUrl`)

---

## 2026-04-02

Highlights
- **Tunnel estabilizado**: versión fija 2025.2.0, --no-autoupdate, --url http://web:3000.
- **Zona horaria corregida**: logs ahora muestran hora UTC-3 Buenos Aires.
- **Mejoras de logging**: separadores visuales entre archivos, ciclos del scheduler y jobs del worker. Log de archivos encontrados vs límite de lote.
- **Fix scheduler requeue**: jobs COMPLETED/FAILED no bloquean reprocesamiento. Filtro status: { in: ["PENDING", "PROCESSING"] } en existingJob.
- **Feature Reprocesar Sin Asignar**: botón ♻️ en sidebar del panel cliente. Endpoints GET /api/client/unassigned/preview y POST /api/client/unassigned/requeue.
- **OCR híbrido**: detección semántica del bloque emisor AFIP + pdftoppm/Tesseract para PDFs con imagen. Reemplazado pdfjs-dist por pdftoppm. poppler-utils en Dockerfile.
- **CUITs alternativos de consorcio**: pipeline verifica CUITs en matchNames. Permite múltiples CUITs por consorcio sin cambios de schema.
- **Sync-directory optimizado**: upsert de Proveedores con constraint único @@unique([clientId, canonicalName]). Logs de timing por etapa. Migración: 20260402000100_provider_unique_client_canonical.

## 2026-03-30

Highlights
- **UI de edición de matchNames por consorcio**: nuevo campo editable en la vista de detalle para configurar nombres alternativos de matching interno. Endpoint `PATCH /api/client/consortiums/[id]` con soporte para `matchNames`.
- **UI de gestión de LspServices por consorcio**: nueva sección "Servicios públicos (LSP)" con tabla de servicios existentes, formulario inline para agregar (dropdown de 8 proveedores, nro. cliente normalizado, descripción), y eliminación con confirmación inline. Endpoints `GET/POST /api/client/consortiums/[id]/lsp-services` y `DELETE .../[lspId]`.
- **Mejora extracción allTaxIds**: DNI con 11 dígitos ahora se incluye en allTaxIds como CUIT mal etiquetado. Ingresos Brutos agregado como señal del CUIT del emisor. CAE y comprobante explícitamente excluidos. Formato normalizado con guiones.
- **Mejora buildInvoicePrompt**: descripción estructural del layout AFIP para distinguir bloque emisor vs receptor. providerTaxId puede ser null sin romper el CUIT-first matching.
- **Fix scheduler requeue**: el scheduler ahora ignora jobs COMPLETED/FAILED al decidir si encolar un archivo. Permite reprocesar archivos que volvieron a Pendientes desde Sin Asignar u otros flujos.
- **Mejora OCR fallback**: el extractor de texto ahora activa Tesseract OCR cuando pdf-parse produce texto sin CUITs detectables, no solo cuando está vacío. Los textos de pdf-parse y OCR se combinan para maximizar la información disponible para la IA.
- **Feature Reprocesar Sin Asignar**: botón "♻️ Sin Asignar" en sidebar del panel cliente. Lista archivos en carpeta Sin Asignar y los mueve a Pendientes con un click. El scheduler los procesa en el próximo ciclo automáticamente. Endpoints: `GET /api/client/unassigned/preview`, `POST /api/client/unassigned/requeue`.

## 2026-03-28

Highlights
- **Manual de usuario creado** (`docs/manual-usuario.md`): documentación completa para usuarios finales no técnicos. Cubre acceso al sistema, panel principal, configuración inicial, archivo ALTA (con ejemplos de tablas para cada hoja), sincronización de directorio, procesamiento automático de boletas, resolución de boletas sin asignar, cierre de período, recibos de pago, y avisos importantes.

## 2026-03-27 (sesión 20)

Highlights
- **Intervalo del scheduler configurable por cliente (`intervalMinutes`)**: nuevo campo en Client con default 60 minutos. Configurable desde el panel admin (1-1440 min). El scheduler respeta el intervalo individual de cada cliente sin necesidad de tocar `.env` ni hacer rebuild. Migración: `20260327000200_add_interval_minutes`.

## 2026-03-27 (sesión 19)

Highlights
- **Boletas sin asignar ya no se guardan en DB**: el bloque `assignment.unassigned` del pipeline ahora solo mueve el archivo a Sin Asignar en Drive, sin crear Invoice en la DB ni persistir el hash. La DB queda limpia con solo boletas efectivamente asignadas.

## 2026-03-27 (sesión 18)

Highlights
- **Sync-directory refactorizado**: transacción única dividida en 5 transacciones independientes por entidad (Rubros, Coeficientes, Consorcios+Períodos, Proveedores, LspServices). Cada una con timeout de 30s. Resuelve "Transaction not found" con datasets grandes.

## 2026-03-27 (sesión 16)

Highlights
- **Prompt facturas normales**: aclaración sobre trampa CUIT emisor vs receptor en facturas B/C donde el CUIT del receptor tiene etiqueta prominente y el del emisor está en el encabezado sin etiqueta explícita.

## 2026-03-27 (sesión 15)

Highlights
- **LSP_LATERAL_CUIT_RULES**: nueva constante compartida para indicar a la IA que el CUIT aparece en el margen lateral izquierdo rotado/vertical. Incluida en prompts de Edesur y Edenor.

## 2026-03-27 (sesión 14)

Highlights
- **Prompt Edesur**: aclaración sobre ubicación del CUIT en margen lateral izquierdo (rotado/vertical) para mejorar extracción IA.

## 2026-03-27 (sesión 13)

Highlights
- **Proveedor LSP resuelto por CUIT desde tabla Provider**: eliminados CUITs hardcodeados de todos los prompts LSP. El pipeline busca el proveedor por CUIT en `allTaxIds` contra la tabla Provider y usa el nombre canónico de la DB. LspService ahora tiene `providerId` FK a Provider. Lookup de LspService: primero por providerId, luego fallback a campo texto. Si el proveedor no está en DB → fallback al nombre del router + warning.
- **Migración pendiente**: `20260327000100_lspservice_add_provider_fk` — agregar `providerId` FK nullable a LspService.
- **Sync-directory mejorado**: resuelve `providerId` al sincronizar `_LspServices` buscando por nombre canónico en Provider.

## 2026-03-26 (sesión 12)

Highlights
- **Normalización de clientNumber para LspService**: el pipeline ahora normaliza `clientNumber` eliminando ceros a la izquierda antes del lookup de LspService (`00366037` → `366037`). Sync-directory también normaliza al guardar desde Sheets.

## 2026-03-26 (sesión 11)

Highlights
- **CUIT como identificador primario en matching**: nuevo campo `allTaxIds` en la extracción IA — la IA extrae todos los CUITs del documento sin clasificarlos. El pipeline ahora busca por CUIT primero en consorcio y proveedor antes de caer al matching por nombre. Excluye automáticamente el CUIT del consorcio al buscar proveedor. Backward-compatible con extracciones viejas.
- **Logger mejorado**: `extractionResult` muestra los CUITs extraídos. Nuevos métodos `consortiumMatchedByCuit` y `providerMatchedByCuit`.

## 2026-03-26 (sesión 10)

Highlights
- **Razón social en nombre de proveedor**: nueva constante `PROVIDER_NAME_RULES` que instruye a la IA a conservar la razón social (S.R.L., S.A., S.A.S., etc.) en el campo `provider`. Incluida en los 7 prompts de extracción. Sin cambios en matching ni normalización.

## 2026-03-26 (sesión 9)

Highlights
- **Validación en producción**: Deploy Docker completo funcionando (Docker Desktop + Cloudflare Tunnel + dominio propio). Los 3 servicios (web, scheduler, worker) operativos.
- **Prompts LSP validados**: Edesur y AySA probados con PDFs reales en producción. Extracción correcta.
- **Aclaración de flujo matchNames**: los matchNames de consorcios y proveedores se cargan y editan desde las hojas `_Consorcios` y `_Proveedores` del archivo ALTA en Google Sheets, y se sincronizan a la DB desde el panel. No requiere UI adicional.
- **Procedimiento de deploy documentado**: deploy estándar con `docker compose up --build -d` y procedimiento completo para migraciones de DB (down → migrate deploy → generate → up --build -d).
- **Límite de PDFs por lote (batchSize)**: nuevo campo `batchSize` en Client (default 10). Scheduler limita PDFs encolados por ciclo. Configurable desde el panel admin (campo "Tamaño de lote" en edición de cliente).
- **Registro de tokens por factura**: nuevos campos en Invoice (`tokensInput`, `tokensOutput`, `tokensTotal`, `aiProvider`, `aiModel`). Pipeline guarda tokens consumidos por cada extracción IA.
- **Página admin Invoices**: nueva ruta `/admin/invoices` (solo ADMIN) con tabla paginada de todas las invoices, filtro por cliente, y columnas de tokens/IA. Endpoint `GET /api/admin/invoices`.
- Migración: `20260326000100_add_batch_size_and_invoice_tokens`.

## 2026-03-24 (sesión 8)

Highlights
- **Purga completa de boletas por cliente (Admin)**: botón "Purgar" en la tabla de métricas del panel admin con modal de 3 pasos (preview → confirmación → resultado).
- **Endpoint GET /api/admin/clients/[id]/purge**: preview que retorna cantidad de boletas del cliente.
- **Endpoint DELETE /api/admin/clients/[id]/purge**: ejecuta purga completa — mueve archivos de Drive a pendientes, limpia Sheets (fila 2+), borra Invoices y ProcessingJobs de DB.
- **Tolerancia a fallos**: si Drive o Sheets fallan, loguea warning y continúa. El borrado de DB se ejecuta siempre.
- **Tracking de tokens con desglose input/output por provider y modelo**: `TokenUsageSummary.byProvider` y `byModel` ahora son `Record<string, TokenUsageBreakdown>` con `inputTokens`, `outputTokens`, `totalTokens`. Persistencia, carga y UI actualizados. Compatible hacia atrás con registros viejos (ceros se suman como 0).

## 2026-03-24 (sesión 7)

Highlights
- **Sidebar colapsable + menú hamburguesa**: panel cliente con sidebar de navegación global (Sincronizar directorio, Consorcios, Cerrar Periodo General, Cerrar sesión). Colapsable en desktop (solo iconos), menú hamburguesa en tablet/mobile.
- **Toggle dark/light con iconos**: reemplazado el botón de texto por switch tipo interruptor con iconos sol/luna. Estado solo de sesión (no persiste).
- **Toolbar superior**: Pausar scheduler / Ejecutar ahora a la izquierda, toggle de tema a la derecha.
- **Cerrar Periodo General**: botón solo visible para rol CLIENT. Modal de 2 pasos: preview con lista de consorcios a cerrar/saltear, luego resultado.
- **Endpoints nuevos**: `GET /api/client/periods/close-all/preview` y `POST /api/client/periods/close-all` con lógica de mes mayoritario.
- **Período por defecto mejorado**: al crear consorcio (manual, import Excel, sync-directory) usa el mes mayoritario entre los períodos activos existentes del cliente.
- **Sync-directory crea períodos**: los consorcios nuevos creados via archivo ALTA ahora reciben período activo automáticamente.

## 2026-03-23 (sesión 6)

Highlights
- **Asignación automática de período a invoices**: el pipeline ahora busca el período ACTIVE del consorcio matcheado y asigna `periodId` al Invoice en DB.
- **Nueva columna `period` en Google Sheets**: formato `MM/YYYY` en posición M (columna nueva al final, sin mover las existentes).
- **Invoices manuales**: también incluyen el período en Sheets al ser creados desde la UI.

## 2026-03-23 (sesión 5)

Highlights
- **Nuevo campo `consortiumsEnabled`**: booleano en Client (default false) para habilitar/deshabilitar la feature de consorcios por cliente.
- **Toggle Premium en panel admin**: columna "Premium" con toggle ON/OFF optimista en la tabla de métricas por cliente. Reemplaza la columna ClientId.
- **Botón Consorcios condicionado**: en el panel CLIENT, el botón "Consorcios" se deshabilita con badge "Premium" si `consortiumsEnabled` es false.
- **Guard en página Consorcios**: la página `/admin/consortiums` verifica `consortiumsEnabled` via `/api/auth/me` y redirige al panel si no está habilitado.
- **Endpoint `/api/auth/me` ampliado**: ahora retorna `consortiumsEnabled` en el user.
- **Endpoint `/api/admin/clients/[id]` ampliado**: GET retorna y PATCH acepta `consortiumsEnabled`.
- **Endpoint `/api/admin/audit/clients` ampliado**: retorna `consortiumsEnabled` por cliente.
- Migración: `20260323000300_add_consortiums_enabled`.

## 2026-03-23 (sesión 4)

Highlights
- **Nuevo modelo LspService**: tabla para registrar servicios de empresas públicas por consorcio (provider + clientNumber + description). Permite lookup automático en el pipeline.
- **Nuevo enum PaymentMethod**: DEBITO_AUTOMATICO, TRANSFERENCIA, EFECTIVO. Campo nullable en Invoice.
- **Campos lspServiceId y paymentMethod en Invoice**: FK nullable a LspService y método de pago detectado por IA.
- **Prompts LSP actualizados**: todos los prompts LSP ahora extraen `clientNumber` y `paymentMethod` con reglas específicas por empresa.
- **Nuevo prompt buildPersonalPrompt**: soporte para facturas de Personal/Telecom Argentina (CUIT 30-63945373-8, keywords PERSONAL/TELECOM en router).
- **Extracción limitada a página 1 para LSP**: reduce ruido en la extracción IA re-extrayendo solo la primera página cuando se detecta un documento LSP.
- **Lookup LspService en pipeline**: después de extraer clientNumber, busca en la tabla LspService para vincular la factura al servicio correspondiente.
- **Nueva columna NRO CLIENTE en Sheets**: columna J con el número de cliente extraído. Las columnas URL_ARCHIVO e ES_DUPLICADO se desplazaron a K y L.
- **Hoja _LspServices en archivo ALTA**: nueva hoja con 4 columnas (NOMBRE CANÓNICO, PROVEEDOR, NRO CLIENTE, DESCRIPCIÓN) sincronizada con reemplazo total.
- **Eliminación de isAutoCreated**: campo removido de Provider y Consortium (ya no existía en el schema actual).
- Migración: `20260323000200_add_lspservice_paymentmethod`.

## 2026-03-23 (sesión 3)

Highlights
- **Auditoría completa pre-producción Docker**: revisión de dependencias, build, variables de entorno, migraciones y Docker setup.
- **Optimización docker-compose**: eliminado triple build redundante. Solo `web` tiene `build:`, los 3 servicios comparten `image: drive-doc-processor:latest`.
- **`.env.example` mejorado**: agregada `GOOGLE_CREDENTIALS_ENCRYPTION_KEY`, comentarios descriptivos, variables agrupadas por categoría.
- **Smoke test del pipeline**: verificación completa de los 10 pasos del pipeline, router LSP, normalización de consorcios, sync-directory. Todo coincide con la documentación.
- **Resultados de auditoría**: TypeScript 0 errores, ESLint 0 errores (8 warnings menores), `build:jobs` OK, 14 migraciones aplicadas (schema up to date).
- **README.md creado** para GitHub con descripción del proyecto, arquitectura, setup Docker, y desarrollo local.
- **Renombrado `alias`/`aliases` → `matchNames` + nuevo campo `paymentAlias`** en Provider y Consortium.
  - `matchNames`: campo interno para matching de PDFs (separado por `|`), no visible en UI.
  - `paymentAlias`: alias visible en UI y en columna "ALIAS" de Google Sheets.
  - Pipeline: columna ALIAS de Sheets ahora escribe `provider.paymentAlias` (vacío si no tiene).
  - Sync ALTA: hojas ampliadas a 4 columnas (NOMBRE CANÓNICO, CUIT, NOMBRES ALTERNATIVOS, ALIAS).
  - Import Excel: nueva columna "Alias de pago" en ambas hojas.
  - Migración: `20260323000100_rename_alias_to_matchnames_add_paymentalias`.

## 2026-03-21 (sesión 2)

Highlights
- **Dockerización completa**: Dockerfile multi-stage con Next.js standalone output, 3 servicios separados (web, scheduler, worker).
- **docker-compose.yml** reescrito: web con healthcheck, scheduler y worker como servicios independientes, Cloudflare Tunnel integrado.
- **Path aliases resueltos**: `tsc-alias` como post-procesador para que `dist/` use paths relativos en vez de `@/`.
- **tsconfig.jobs.json** arreglado: excluye `useAuthGuard.ts` (DOM) y shim para `CanvasRenderingContext2D`.
- **ESLint** configurado con `typescript-eslint` + `@next/eslint-plugin-next`. 0 errores, 8 warnings.
- **GitHub Actions CI/CD**: workflow con 3 jobs (check → build → deploy a self-hosted runner).
- **Scripts nuevos**: `build:jobs`, `lint`, `typecheck`, `check` (pipeline completo pre-deploy).
- **Fixes de build**: encoding UTF-8 en `close-period/route.ts`, async params en `receipt/route.ts`, creado `clientAuth.ts` faltante, type cast en `scan/route.ts`.

## 2026-03-21

Highlights
- Refactorización completa de `extraction.ts`: nuevo router `identifyLSPProvider()` que detecta la empresa de servicios y despacha a un prompt específico.
- Prompts dedicados para: Edesur (`buildEdesurPrompt`), Edenor (`buildEdenorPrompt`), AySA (`buildAysaPrompt`), Metrogas/Naturgy/Camuzzi/Litoral Gas (`buildGasPrompt`), y genérico LSP (`buildGenericUtilityBillPrompt`).
- CUIT de cada empresa hardcodeado en su prompt → resuelve confusión entre CUIT del proveedor y del consorcio.
- Reglas de dueDate específicas por empresa → resuelve extracción errónea de fecha CESP/CAE como fecha de pago.
- Reglas de dirección unificadas en `CONSORTIUM_ADDRESS_RULES` con instrucciones de limpiar ceros, sufijos, CP, piso.
- `consortiumNormalizer.ts` mejorado: nuevas funciones `stripLeadingZeros`, `stripTrailingNumericSuffix`, `stripPostalAndLocality`, `stripFloorUnit`.
- Fuzzy match ahora limpia ceros a la izquierda en ambos lados antes de comparar tokens.
- Alias match soporta fuzzy inverso (OCR → alias además de alias → OCR).
- Nuevas abreviaturas de calles: SGTO→SARGENTO, CTE→COMANDANTE, INT→INTENDENTE, PROF→PROFESOR.
- Nuevo módulo `src/lib/logger.ts` — sistema de logging centralizado con timestamps, emojis, separadores visuales y logs estructurados por proceso (scheduler, worker, pipeline, run-cycle).
- Scheduler ahora muestra: inicio de ciclo con cantidad de clientes, estado por cliente (pausado/escaneando/sin PDFs/jobs encolados), fin de ciclo, y errores detallados.
- Worker ahora muestra: job reclamado con nombre de archivo y cliente, duración del job, reintentos y fallas permanentes.
- Pipeline ahora muestra: cada paso del procesamiento (descarga, hash, extracción IA, matching, canonización, destino), tipo de LSP detectado, resultado de cada match (método + nombre canónico), y resumen del lote.
- Establecida regla obligatoria de documentación: `docs/progreso.md`, `docs/decisiones.md` y `CHANGELOG.md` deben actualizarse con cada cambio significativo.
- Actualizado CLAUDE.md con sección de router LSP, tabla de prompts por empresa, y regla de documentación.
- Inicializado `docs/decisiones.md` con las primeras decisiones técnicas documentadas.
- Actualizado `docs/progreso.md` al estado actual.

## 2026-03-20

Highlights
- Implementada feature de sincronización de directorio desde archivo Google Sheets ALTA (Sheets → DB).
- Nuevo endpoint `POST /api/client/sync-directory`: lee 4 hojas del archivo ALTA y upserta Consorcios, Proveedores, Rubros y Coeficientes en DB.
- Auto-creación de hojas `_Consorcios`, `_Proveedores`, `_Rubros`, `_Coeficientes` con encabezados si no existen.
- Tablas Rubro y Coeficiente movidas a nivel cliente (no por consorcio).
- Nuevo campo `lastDirectorySyncAt` en `SchedulerState` para registrar la última sincronización.
- Nuevo campo `altaSheetsId` en `googleConfigJson` del cliente para apuntar al archivo ALTA separado.
- UI: botón "Sincronizar directorio" en el panel admin (solo rol CLIENT).
- UI: badge "Última sync directorio" en card de estado del panel.
- UI: botón "Editar" por cliente en tabla de métricas → nueva página `/admin/clients/[id]`.
- Nueva página de edición de configuración de cliente (`/admin/clients/[id]`) con secciones: General, Sheets, Drive, Credenciales Google, Claves IA.
- Nuevo endpoint `GET /PATCH /api/admin/clients/[id]` — campos sensibles enmascarados en GET, encriptados en PATCH.
- CRUD endpoints para Rubros (`/api/client/rubros`) y Coeficientes (`/api/client/coeficientes`).
- Comando `npm run local` como atajo para levantar los 3 procesos con PowerShell.
- Migración `20260320000100_rubro_coeficiente_to_client_level` (pendiente de aplicar).
- Resuelto bug: private key encriptada pasada directamente a GoogleSheetsService → usar siempre `resolveGoogleConfig(client)`.

## 2026-03-16

Highlights
- Added ProcessingJob queue with dedicated worker/scheduler split and env loading helpers.
- Added consortium/provider/period models with normalization, auto-period creation and client endpoints.
- Updated docs/scripts for local run and docker workflow.

PRs
- https://github.com/johnydeev/drive-doc-processor/commit/101fac2553d13c431fcb671d2986a2a358e48991
- https://github.com/johnydeev/drive-doc-processor/commit/6f9359fd15c858bc5be9e8939fcd665d77ed2acf
- https://github.com/johnydeev/drive-doc-processor/commit/73f88a42944cc6eff18b1535a3ea2f64c331c87d

## 2026-03-12

Highlights
- Added VIEWER role to ClientRole and updated related admin/scheduler logic.
- Updated PDF parsing method in PdfTextExtractorService.
- Removed unused Invoice model fields and adjusted business key/repository logic.

PRs
- https://github.com/johnydeev/drive-doc-processor/commit/abf01f8
- https://github.com/johnydeev/drive-doc-processor/commit/17a3b0d
- https://github.com/johnydeev/drive-doc-processor/commit/b44534b
