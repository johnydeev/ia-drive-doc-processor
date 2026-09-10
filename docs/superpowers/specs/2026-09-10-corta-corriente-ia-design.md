# Corta-corriente de IA: dejar de pagar por descubrir 23 veces que la cadena está caída

**Fecha:** 2026-09-10
**Estado:** spec aprobado, sin implementar
**Origen:** dos jornadas completas de producción (2026-09-08 y 2026-09-09) con la cadena de IA caída
mandaron 24 archivos a Revisión con el cartel `SIN MONTO` —23 de ellos boletas sanas— y quemaron 135
requests para lograrlo. El owner pidió dejar de gastar requests en boletas que no van a entrar.

---

## 1. La medición (hecha, no es propuesta)

Sobre `ProcessingJob` de producción, 2026-09-08 y 2026-09-09. **263 requests, 112 archivos.**

| Resultado | Archivos | Requests | % del gasto |
|---|---|---|---|
| **SIN MONTO** (`no_amount`) | 24 | **135** | **51 %** |
| Entraron (`ok`) | 71 | 111 | 42 % |
| Sin Asignar por CUIT / LSP | 11 | 13 | 5 % |
| Vuelta a Pendientes | 1 | 4 | 2 % |
| Duplicados | 5 | 0 | 0 % |

Desglose de las 24 `no_amount` por lo que gastó cada una:

| Requests gastados | Archivos |
|---|---|
| 1 | 1 |
| 5 | 5 |
| 6 | 17 |
| 7 | 1 |

**El de 1 request es el único legítimo**: una captura de pantalla `.png`. La IA la leyó y devolvió
`amount: null`, que es correcto — no es una boleta. Los otros 23 gastaron 5 a 7 requests **barriendo
la cadena entera con los tres proveedores caídos**, y terminaron en `OCR_ONLY`, que devuelve
`amount: null` por construcción.

Los mensajes, textuales, de los logs del worker:

```
IA: GEMINI falló — los 3 modelo(s) del barrido fallaron por cuota o saturación (429/503)
IA: CEREBRAS falló — 402 status code (no body)
IA: OPENAI falló — 429 You have no credits remaining.
IA: Ambos proveedores fallaron → OCR_ONLY
```

### 1.1 El experimento controlado

El 2026-09-10 el owner movió 4 archivos `SIN MONTO` de Revisión a Pendientes **sin dar de alta nada**.
Los cuatro entraron. Mismo `driveFileId`, mismos bytes, misma base:

| Archivo | Pasada del 09/09 | Pasada del 10/09 |
|---|---|---|
| `FA-B 00005-00053690` | `no_amount` — 6 requests | `ok` — 1 request |
| `FA-B 00005-00052999` | `no_amount` — 5 requests | `ok` — 1 request |
| `FC. ABONO SEPTIEMBRE 2026.` | `no_amount` — 5 requests | `ok` — 3 requests |
| `1702.Garay 350` | `no_amount` — 6 requests | `ok` — 1 request |

Entraron como CABRERA 6057 / GESTION CONTINUA (57.000), BOEDO 414 / GESTION CONTINUA (69.000),
GARAY 350 / CUÑADO FEDERICO NICOLAS (60.812) y CASTILLO 246 / MARINO ROBERTO ALEJANDRO (178.384).

**Conclusión, con la variable controlada: el cartel `SIN MONTO` no describe la boleta, describe que
nadie la leyó.** Describirlo costó 22 requests para esas cuatro.

### 1.2 El techo real de Gemini

Como subproducto de la medición, el techo documentado en `CLAUDE.md` y en `scripts/metrics-cuota.sql`
("~20 requests/día por modelo, piso de referencia ~60/día") **no coincide con lo observado**:

| | Documentado | Medido (2 días) |
|---|---|---|
| Por modelo | ~20 | ~34-40 |
| Total Gemini/día | ~60 | 91-107 |
| **Boletas que entran limpias por día** | — | **~35** |

Las cuotas RPD de Gemini **se reinician a medianoche del Pacífico** (04:00 en Argentina) y los límites
se aplican **por proyecto, no por API key** — verificado en `ai.google.dev/gemini-api/docs/rate-limits`
el 2026-09-09. Una segunda key del mismo proyecto no agrega cuota.

---

## 2. Por qué el sistema se comporta así

### 2.1 El gasto se repite por archivo

`processDriveFile` corre los pasos de `src/jobs/processPendingDocuments.job.ts:1743`:

```
downloadAndLock → dedupHash → textExtract → documentTriageGate
→ aiExtract          ← acá se gasta
→ isBoletaGate → missingAmountGate → cuitSanitize → businessKeyDedup
→ cleanClientNumber → assignment → canonize → lsdFanOut
→ unassignedGate → noPeriodGate → sheets → fileOrganization → persist
```

No hay ningún estado entre archivos. Cada boleta **redescubre desde cero** que los proveedores están
caídos, y paga el barrido completo para averiguarlo. Los 23 archivos pagaron 134 requests para
establecer 23 veces el mismo hecho.

### 2.2 La red existe pero no se activa

`aiExtractStep` (~línea 1004) decide entre devolver la boleta a Pendientes o degradar a OCR_ONLY:

```ts
} else if (aiFailures > 0 && aiRateLimited === aiFailures) {
  throw new RateLimitError(...);      // → Pendientes
} else {
  extracted = buildOcrOnlyPayload();  // → amount null → SIN MONTO → Revisión
}
```

Exige que **todas** las fallas sean transitorias. En la caída real:

| Proveedor | Error | `isRateLimitError` |
|---|---|---|
| Gemini | 429/503 en los 3 modelos | **true** |
| Cerebras | `402 status code (no body)` | **false** |
| OpenAI | `429 You have no credits remaining` | true |

`isRateLimitError` (`src/lib/aiErrors.ts:23`) mira `status === 429`, los códigos
`rate_limit_exceeded` / `insufficient_quota`, y el texto (`429`, `quota`, `too many requests`,
`sin cuota`). **Un 402 no matchea ninguno.** Con 2 de 3, la condición falla y las boletas degradan.

**El 402 de Cerebras es la única razón por la que 23 boletas sanas fueron a Revisión en vez de volver
a Pendientes.** La prueba está en la excepción: `CERRAR.jpg`, una imagen, va por la rama de Vision que
sólo intenta Gemini — una sola falla, transitoria, condición cumplida, y **sí volvió a Pendientes**.

El spec `2026-08-24-gemini-tier-pago-cadena-y-modelos-design.md` §4 ya lo había anotado: "Mover
Cerebras fuera de la cadena. Queda segundo. **El 402 por cuota agotada se trata aparte.**" Este es
ese aparte.

---

## 3. Decisiones tomadas

| Decisión | Elegido | Por qué |
|---|---|---|
| Alcance | **Sólo el corta-corriente** | Es el 51 % del gasto. El chequeo de CUIT previo a la IA se evaluó y se descartó — ver §7 |
| Duración del corte | **Cooldown de 30 minutos** | Se recupera solo. Medido: Gemini volvió a contestar a las 15:17 del 09/09 tras caer a las 09:10 |
| Alcance del breaker | **Por cliente** | Las API keys viven en `googleConfigJson` de cada cliente; que uno queme su cuota no debe cegar a otro |
| Gatillo | **Sólo fallas de infraestructura** | Una boleta que la IA rechaza por contenido no debe cortar la cadena para las siguientes |
| Destino de la boleta cortada | **Pendientes** | Vuelve a entrar sola en el ciclo siguiente. Es lo que evita el rescate manual |
| Dónde se chequea | **Entre `dedupHash` y `textExtract`** | Ahorra también el OCR con tesseract, lo más caro en CPU. Ver §4.3 |
| Instrumentación | `reasonCategory = "circuit_open"` | Permite contar cuántas boletas salvó y verificar que no gastan |

---

## 4. Diseño

### 4.1 El módulo

Módulo nuevo `src/lib/aiCircuitBreaker.ts`, estado en memoria del proceso:

```ts
export class AiCircuitBreaker {
  constructor(now?: () => number, cooldownMs?: number);  // default 30 min
  isOpen(clientId: string): boolean;
  trip(clientId: string, reason: string): void;
}
```

Un `Map<clientId, trippedUntil>`. El reloj se inyecta para que los tests no esperen tiempo real —
mismo patrón que el `sleep` inyectable de `GeminiExtractorService`.

Se suma al `ProcessingContext` que viaja en `ctx.deps`, con un singleton de módulo como default.

### 4.2 Dónde se dispara

En `aiExtractStep`, después de que `aiChain.run` devuelve `null`:

```
si TODAS las fallas son de infraestructura → trip(clientId) + RateLimitError → Pendientes
si no                                       → OCR_ONLY (comportamiento actual)
```

La primera boleta —la que descubre la caída— **también vuelve a Pendientes**, no a Revisión.

### 4.3 Dónde se chequea

Paso nuevo `circuitBreakerGate`, **entre `dedupHashStep` y `textExtractStep`**:

```
downloadAndLock → dedupHash → circuitBreakerGate → textExtract → documentTriageGate → aiExtract → …
```

El gate corta sólo si el archivo **realmente va a necesitar la IA**:

```ts
async function circuitBreakerGate(ctx: PipelineContext): Promise<StepResult> {
  // Un duplicado NO llama a la cadena: `aiExtractStep` reusa la extracción
  // guardada (`existingByHash.extraction`). Frenarlo acá lo mandaría a Pendientes
  // en vez de a Duplicados, que es una regresión.
  if (ctx.isDuplicate) return { kind: "continue" };
  if (!breaker.isOpen(clientId)) return { kind: "continue" };
  throw new RateLimitError("Cadena de IA cortada por el corta-corriente");
}
```

`RateLimitError` → Pendientes. **0 requests, 0 tokens.**

Chequear acá y no dentro de `aiExtractStep` ahorra además la **extracción de texto**, que en PDFs
escaneados hace OCR con tesseract — lo más caro en CPU de todo el pipeline. Con el scheduler
encolando cada ~20 min y un cooldown de 30, cada archivo pendiente pagaría ese OCR dos veces por
caída.

**No se chequea antes de `dedupHash`**: el hash es del binario, así que la descarga es inevitable, y
`dedupHash` es lo que deja saber si el archivo necesita la IA. Ese orden es lo que permite la
excepción del duplicado.

> **El duplicado no evita la IA cortando el pipeline: la evita por caché.** `aiExtractStep` reusa
> `existingByHash.extraction` y marca `extractionWasCached`, por eso registra `aiRequests = 0` aunque
> recorra todos los pasos. Sin la guarda explícita de arriba, el gate lo rompería.

**Costo aceptado:** con el breaker abierto tampoco corre `documentTriageGate`, así que un VEP o una
no-boleta rebota a Pendientes en vez de ir a Sin Asignar con su etiqueta. Se corrige solo en el
reintento posterior, cuando el breaker vuelve a cerrar.

### 4.4 Clasificación de errores

En `src/lib/aiErrors.ts`, junto a `isRateLimitError` e `isTransientServerError`:

```ts
/** El proveedor no está disponible para nosotros: sin crédito / sin plan. */
export function isProviderDownError(error: unknown): boolean;   // 402, "no credits", "payment required"
```

El guard de `aiExtractStep` pasa de `aiRateLimited === aiFailures` a **`aiInfraFailures === aiFailures`**,
donde infraestructura = rate limit (429/cuota) ∨ transitorio (503) ∨ proveedor caído (402).

Una falla de contenido (JSON malformado, respuesta ilegible) **no** cuenta como infraestructura: esa
boleta degrada sola a OCR_ONLY y la siguiente se intenta normal.

---

## 5. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| **El breaker se dispara de más** y rebota boletas sanas 30 minutos | El gatillo exige que **todas** las fallas sean de infraestructura. Una falla de contenido no dispara |
| **El breaker queda abierto con los proveedores ya sanos** | Cooldown de 30 min: se re-sondea solo. Costo del sondeo: ~6 requests por hora de caída |
| **No se puede distinguir una boleta frenada por el breaker de un rate-limit normal** | `reasonCategory = "circuit_open"`. Se cuenta en la base |
| **Una no-boleta rebota sin etiquetar durante la caída** | Aceptado (§4.3). Se corrige en el reintento |

### Riesgo descartado, con evidencia

**Devolver la boleta a Pendientes no consume reintentos.** El runner atrapa el `RateLimitError` y hace
`return` sin relanzar (`src/jobs/pipeline/runner.ts`), así que el job cierra `COMPLETED` y el
incremento `attempts + 1` queda **después** de ese camino (`src/jobs/jobWorkerMain.ts:108`).

Una caída larga de la cadena **no puede** agotar `maxAttempts` ni mandar boletas sanas a `FAILED`.

---

## 6. Tests

| Qué | Dónde |
|---|---|
| `402` clasifica como proveedor caído; `429` sigue siendo rate limit; `503` sigue siendo transitorio | `aiErrors.test.ts` |
| El breaker dispara con fallas de infraestructura | `aiCircuitBreaker.test.ts` |
| El breaker **no** dispara con una falla de contenido | `aiCircuitBreaker.test.ts` |
| El cooldown expira, con reloj inyectado (sin esperar de verdad) | `aiCircuitBreaker.test.ts` |
| El breaker es por cliente: abrir uno no afecta al otro | `aiCircuitBreaker.test.ts` |
| Breaker abierto → boleta a Pendientes con `aiRequests = 0` y **sin extracción de texto** | `processPendingDocuments.job.test.ts` |
| Breaker abierto → un **duplicado** sigue resolviéndose con 0 requests | `processPendingDocuments.job.test.ts` |
| Cadena caída entera → la primera boleta va a **Pendientes**, no a Revisión | `processPendingDocuments.job.test.ts` |

La red de caracterización existente (1 test por camino de salida) tiene que correr **verde antes y
después**.

---

## 7. Alternativas descartadas

### 7.1 El chequeo de CUIT previo a la IA (evaluado en detalle, descartado)

La idea: adelantar el chequeo de CUITs —que se extraen del texto con regex y checksum, **0 tokens**—
para no pagar un request por una boleta que no va a poder asignarse. Está anotada en `docs/progreso.md`
como pendiente y el spec `2026-08-31-triage-no-boletas-decisivo-design.md` la dejó fuera de alcance
"hasta que la instrumentación diga cuánto pesa esa clase".

**La instrumentación ya lo dijo: pesa 13 requests en dos días (5 %).** Y cada revisión del diseño bajó
ese número al buscar una regla segura:

| Regla evaluada | Ahorro medido | Por qué se descartó |
|---|---|---|
| "Menos de 2 CUITs válidos → descartar" (la documentada) | 2 requests | Casi ninguna boleta real cae ahí |
| Cortar todas las categorías por CUIT | 9 requests | Mata el rescate por Vision: un PDF puede tener texto propio y el membrete en imagen (caso GESTIONPRO) |
| Cortar sólo `*_cuit_not_registered` | 7 requests | `hasProviderCuit` es `true` con **cualquier** CUIT que no sea el del consorcio — un CUIT de retención o de un tercero alcanza. No prueba que se haya leído el del emisor |
| Cortar sólo si ningún CUIT extraído matchea la base (regla del owner) | **~2 requests, posiblemente 0** | Es la única segura, y no ahorra |

La última merece la explicación, porque es estructural: **`provider_cuit_not_registered` sólo existe
si el consorcio ya matcheó** — la rama del proveedor corre después de que la del consorcio tuvo éxito.
En esas boletas siempre hay un CUIT que matchea la base, así que la regla segura nunca corta.

Dicho de otro modo: **las categorías por CUIT están nombradas según qué lado falló, lo que implica que
el otro lado matcheó.** La clase de boletas que se puede cortar sin riesgo casi no existe.

Queda anotado en `docs/progreso.md` con esta medición y con la regla del owner, para retomarlo si
alguna vez sube el volumen de boletas que rebotan por CUIT.

### 7.2 Sobre el corta-corriente

- **Corte hasta que se vacíe la cola.** Respeta el precedente de no meter tiempo en el estado, pero
  con el scheduler encolando cada ~20 min cada tanda vuelve a pagar el barrido: ~18 requests/hora
  contra ~6 del cooldown, medido sobre las tandas reales.
- **Corte hasta reiniciar el worker.** Ahorro máximo, pero si Gemini se recupera a las dos horas el
  worker sigue ciego hasta que alguien reinicie el contenedor a mano.
- **Estado del breaker en la base.** Lo verían worker, web y scheduler, pero agrega migración y una
  escritura por boleta para un estado que vive 30 minutos.
- **El breaker adentro de `AiExtractionChain`.** La cadena se construye por archivo, así que el estado
  tendría que ser `static` igual, y mezcla política con mecanismo.
- **Chequear antes de `dedupHash`.** Ahorraría la descarga, pero el hash se calcula sobre el binario:
  sin descarga no hay dedup, y un duplicado pasaría a rebotar a Pendientes en vez de resolverse.

---

## 8. Apartamiento de precedentes, explícito

El spec `2026-08-24-gemini-tier-pago-cadena-y-modelos-design.md` descartó por escrito:

> Descartado: hacer que el modelo pegado expire a los N minutos. Introduce tiempo en el estado —y por
> lo tanto un test que depende del reloj— para cubrir un caso que 429 y 503 ya cubren entre los dos.

**Este spec se aparta de ese precedente a propósito.** La diferencia: en el modelo pegajoso el reloj
era redundante, porque el próximo 429 o 503 reevaluaba solo. En el corta-corriente **no existe ninguna
otra señal de reset**: sin reloj, las opciones son "hasta que se vacíe la cola" (3× más caro, medido)
o "hasta reiniciar" (ciego). Acá el tiempo hace un trabajo que nada más hace.

La objeción del test se resuelve con el patrón que el mismo proyecto ya usa: el reloj se inyecta.

---

## 9. Fuera de alcance

- **El chequeo de CUIT previo a la IA** (§7.1). Se evaluó, se midió y se descartó por ahora.
- Cargar crédito en Cerebras u OpenAI. Es del owner, y es lo único que devuelve una red real cuando
  Gemini se agota. El breaker reduce el desperdicio; no reemplaza al segundo proveedor.
- Cambiar el orden de `PROVIDER_ORDER` o sacar Cerebras de la cadena.
- UI para ver el estado del breaker.
- Rescate automático de las boletas que ya quedaron en Revisión con `SIN MONTO`. Se mueven a mano una
  única vez.
- Corregir el techo documentado de Gemini en `CLAUDE.md` y `scripts/metrics-cuota.sql` (§1.2). Va como
  actualización de documentación, no como código.

---

## 10. Verificación

`npm run typecheck` + `npx vitest run` + `npm run lint` + `npm run build:jobs`. **Sin migración**:
`reasonCategory` ya es una columna de texto nullable.

Verificación real, tras un par de días en producción — el control es que **no gasten**:

```sql
SELECT count(*), sum("aiRequests")
FROM "ProcessingJob"
WHERE "reasonCategory" = 'circuit_open';
```

`sum("aiRequests")` tiene que dar **0**. Si da más, el corte se está haciendo después de llamar a la
IA y no ahorra nada.

Y el indicador de que el problema original se resolvió:

```sql
SELECT count(*), sum("aiRequests")
FROM "ProcessingJob"
WHERE outcome = 'no_amount'
  AND "createdAt" >= now() - interval '7 days';
```

Tiene que bajar de ~12/día a los casos legítimos (documentos que la IA leyó y no tenían monto).

---

## 11. Documentación a actualizar al terminar

Por la regla obligatoria de `CLAUDE.md`: `docs/progreso.md`, `docs/decisiones.md` y `CHANGELOG.md`.

Además:
- `CLAUDE.md`: el techo de cuota de Gemini y la hora de reset (§1.2).
- `scripts/metrics-cuota.sql`: el comentario del encabezado dice "~20 requests/día por modelo… piso de
  referencia ~60/día". Corregir con lo medido.
- `docs/progreso.md`: la sección "⏳ Lo único que quedaría: adelantar la regla antes de la IA" se
  reemplaza por el resultado de §7.1 — la idea se midió, se evaluaron cuatro reglas y ninguna paga.
