# El VEP de ARCA como gasto — Plan de implementación

> **Nota del proyecto:** este plan **no lleva pasos de commit**. En este repo Claude nunca commitea ni
> hace staging: el owner maneja los commits con GitLens. Cada tarea termina en "verificar".

**Estado: EJECUTADO el 2026-09-03.** typecheck + lint (0 errores) + 899 tests + build:jobs OK.

**Goal:** que un VEP de ARCA se registre como gasto del consorcio que figura como contribuyente, con proveedor ARCA, en vez de descartarse como no-boleta.

**Architecture:** `"VEP"` se suma a `LSPProvider` y a **`usesConsortiumCuit`**, el grupo donde el CUIT del papel identifica al consorcio. Pero `usesConsortiumCuit` **no alcanza** para neutralizar el CUIT de la administradora que viaja en todos los VEP: solo habilita el match por nombre, y el match por CUIT corre igual, antes. Hace falta además **cortarle `allTaxIds` al matching de proveedor** en el pipeline. Prompt propio, y el VEP sale de la capa 0 del triage.

> La primera versión de este plan daba por hecho que `usesConsortiumCuit` bastaba y que el
> pipeline no se tocaba. Es falso — ver la enmienda §3.2 del spec. Sin la Task 4, los VEP se
> imputan a la administradora: el bug exacto que la feature dice prevenir.

**Tech Stack:** TypeScript, Vitest (proyecto `node`). Sin migración.

**Spec:** `docs/superpowers/specs/2026-09-03-vep-arca-como-gasto-design.md`

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `src/lib/vepExtraction.ts` **(nuevo)** | Prompt del VEP. Puro |
| `src/lib/extraction.ts` | `"VEP"` en `LSPProvider`, detección en el router, `usesConsortiumCuit`, case del prompt |
| `src/lib/documentClassifier.ts` | Sacar `VEP` de los marcadores decisivos (la capa 0 queda vacía) |
| `src/jobs/processPendingDocuments.job.ts` | Cortar `allTaxIds` y `providerTaxId` en el matching de proveedor del VEP; consorcio por CUIT solamente; guard de `clientNumber` |

---

### Task 1: Prompt del VEP

**Files:**
- Create: `src/lib/vepExtraction.ts`
- Test: `src/lib/vepExtraction.test.ts`

- [x] **Step 1: Escribir el test que falla**

```ts
import { describe, expect, it } from "vitest";
import { buildVepPrompt } from "./vepExtraction";

describe("buildVepPrompt", () => {
  const prompt = buildVepPrompt("VEP\nVolante Electrónico de Pago\nNro. VEP: 1570130517");

  it("fija el proveedor en ARCA en vez de dejarlo al modelo", () => {
    expect(prompt).toContain("ARCA");
    expect(prompt).toContain('"provider": "ARCA"');
  });

  it("nombra los rótulos exactos del papel", () => {
    expect(prompt).toContain("Nro. VEP");
    expect(prompt).toContain("Día de Expiración");
    expect(prompt).toContain("Importe total a pagar");
  });

  it("prohíbe usar el CUIT de 'Generado por el Usuario'", () => {
    // Es el CUIT de la administradora y viaja en TODOS los VEP.
    expect(prompt).toContain("Generado por el Usuario");
    expect(prompt).toMatch(/NO .*(us|tom)/i);
  });

  it("pide el CUIT del contribuyente como consorcio", () => {
    expect(prompt).toContain("contribuyente");
  });

  it("incluye el texto del documento", () => {
    expect(prompt).toContain("Nro. VEP: 1570130517");
  });
});
```

- [x] **Step 2: Correr y ver fallar**

Run: `npx vitest run src/lib/vepExtraction.test.ts`
Expected: FAIL — `Failed to resolve import "./vepExtraction"`

- [x] **Step 3: Implementar**

```ts
/**
 * VEP (Volante Electrónico de Pago) de ARCA — el cupón con el que un consorcio
 * paga las cargas sociales de su encargado.
 *
 * Prompt propio y no `buildArcaPrompt`: ese está escrito para la declaración
 * jurada F931 de dos páginas, donde el importe vive en la página 2. Un VEP es un
 * cupón simple con todos sus campos rotulados.
 *
 * Ver `docs/superpowers/specs/2026-09-03-vep-arca-como-gasto-design.md`.
 */
export function buildVepPrompt(text: string): string {
  return [
    "Sos un extractor de datos de un VEP (Volante Electrónico de Pago) de ARCA, Argentina.",
    "Devolvé SOLO JSON con esta forma:",
    '{ "boletaNumber": "...", "provider": "ARCA", "providerTaxId": null,',
    '  "consortium": null, "amount": 0, "dueDate": "YYYY-MM-DD|null",',
    '  "detail": "...", "allTaxIds": ["XX-XXXXXXXX-X"] }',
    "",
    "- boletaNumber: el valor de 'Nro. VEP'.",
    "- provider: SIEMPRE la cadena \"ARCA\". No la deduzcas del papel.",
    "- providerTaxId: SIEMPRE null. ARCA no imprime su CUIT en el VEP.",
    "- amount: el valor de 'Importe total a pagar' (el total, no los conceptos sueltos).",
    "- dueDate: el valor de 'Día de Expiración'.",
    "- detail: 'Descripción Reducida' y 'Período', separados por ' · '.",
    "",
    "- allTaxIds: SOLO el CUIT rotulado 'CUIT:' — es el del CONTRIBUYENTE, o sea el",
    "  consorcio que paga. Es el único CUIT que hay que devolver.",
    "- **NO uses ni devuelvas el número que figura en 'Generado por el Usuario'.** Es el",
    "  CUIT de quien generó el trámite (la administradora), NO el del contribuyente, y",
    "  aparece en todos los VEP. Confundirlos imputa el gasto a la persona equivocada.",
    "",
    "Texto del VEP:",
    text,
  ].join("\n");
}
```

- [x] **Step 4: Correr y ver pasar**

Run: `npx vitest run src/lib/vepExtraction.test.ts`
Expected: PASS (5 tests)

---

### Task 2: El router reconoce el VEP

**Files:**
- Modify: `src/lib/extraction.ts` (tipo, detección, `usesConsortiumCuit`, case del prompt)
- Test: `src/lib/extraction.test.ts`

- [x] **Step 1: Escribir los tests que fallan**

```ts
describe("identifyLSPProvider — VEP de ARCA", () => {
  /** Texto real del VEP de ALMIRANTE BROWN 706, recortado. */
  const VEP_TEXT = `VEP
Volante Electrónico de Pago
Atención: este VEP esta pendiente de pago y expira en 30 día/s
Nro. VEP: 1570130517
Organismo Recaudador: ARCA
Tipo de Pago: Empleadores SICOSS - Saldo DJ
CUIT: 30-52063978-7
Período: 2025-12
Generado por el Usuario: 27324998573
Día de Expiración: 2026-02-08
Importe total a pagar $1.123.728,00`;

  it("identifica un VEP", () => {
    expect(identifyLSPProvider(VEP_TEXT)).toBe("VEP");
  });

  it("un F931 (la declaración jurada) sigue siendo ARCA, no VEP", () => {
    const f931 = "ARCA F. 931 S.U.S.S. DECLARACION JURADA CUIT 30-52063978-7 Total $ 1.200.000";
    expect(identifyLSPProvider(f931)).toBe("ARCA");
  });

  // El caso que de verdad importa: un F931 real TRAE un VEP en su página 2, o sea su
  // texto contiene los marcadores. Lo único que lo distingue es la POSICIÓN. `ARCA_TEXT`
  // ya existe en este archivo y deja "Volante Electrónico de Pago" en el carácter ~227,
  // contra una ventana de 200: 23 de margen. Este test es el que avisa si se achica.
  it("un F931 REAL, con su VEP en la página 2, sigue siendo ARCA", () => {
    expect(ARCA_TEXT).toContain("Volante Electrónico de Pago");
    expect(identifyLSPProvider(ARCA_TEXT)).toBe("ARCA");
  });

  it("una factura común no se identifica como VEP", () => {
    expect(identifyLSPProvider("FACTURA B 0001 CUIT 30-12345678-9 TOTAL $ 1000 CAE 123")).toBeNull();
  });

  it("el VEP usa el CUIT del papel como consorcio y matchea proveedor por nombre", () => {
    expect(usesConsortiumCuit("VEP")).toBe(true);
  });

  it("buildExtractionPrompt rutea un VEP a su prompt propio", () => {
    const prompt = buildExtractionPrompt(VEP_TEXT);
    expect(prompt).toContain("Volante Electrónico de Pago");
    expect(prompt).toContain('"provider": "ARCA"');
  });
});
```

- [x] **Step 2: Correr y ver fallar**

Run: `npx vitest run src/lib/extraction.test.ts`
Expected: FAIL — devuelve `null`, no `"VEP"`

- [x] **Step 3: Sumar `"VEP"` al tipo y al grupo del CUIT del consorcio**

En `LSPProvider`, junto a `"LSD"`:

```ts
export type LSPProvider =
  | "LSD"
  | "VEP"
  | "EDESUR"
```

Y en `usesConsortiumCuit`:

```ts
export function usesConsortiumCuit(lspProvider: LSPProvider | null | undefined): boolean {
  return (
    lspProvider === "SUTERH" ||
    lspProvider === "FATERYH" ||
    lspProvider === "SERACARH" ||
    lspProvider === "ARCA" ||
    // El CUIT del VEP es el del CONTRIBUYENTE (el consorcio). El proveedor es
    // ARCA y se matchea por nombre — eso deja inerte el CUIT de la administradora
    // que viaja en todos los VEP como "Generado por el Usuario".
    lspProvider === "VEP"
  );
}
```

- [x] **Step 4: Detectar el VEP en el router**

El helper reusa los marcadores ya calibrados para el triage, con la misma ventana de
encabezado (los primeros 200 caracteres) que evita confundir un F931 —que trae el VEP
en su página 2— con un VEP suelto:

```ts
/**
 * Marcadores del encabezado de un VEP. Vienen del triage de no-boletas
 * (2026-08-31), calibrados sobre 5 papeles reales; el VEP dejó de descartarse y
 * pasó a procesarse, así que los marcadores se mudaron acá.
 *
 * La ventana de 200 caracteres es lo que separa un VEP suelto de un F931: la
 * declaración jurada trae su VEP en la página 2, o sea su texto CONTIENE
 * "Volante Electrónico de Pago" pero mucho más abajo.
 */
const VEP_HEADER_CHARS = 200;
const VEP_HEADER_MARKERS = ["VOLANTE ELECTRONICO DE PAGO", "NRO. VEP:", "NRO VEP:"];

function isVep(upper: string): boolean {
  const header = upper.slice(0, VEP_HEADER_CHARS).normalize("NFD").replace(/[̀-ͯ]/g, "");
  return VEP_HEADER_MARKERS.some((marker) => header.includes(marker));
}
```

En `identifyLSPProvider`, **después del LSD y antes de los sindicales/ARCA**:

```ts
  // El VEP es el CUPÓN DE PAGO de una declaración jurada. Va antes de la regla del
  // 931 porque un VEP de SICOSS no imprime ese número, y antes de los sindicales
  // por el mismo criterio de especificidad.
  if (isVep(upper)) return "VEP";
```

Y el case del prompt en `buildExtractionPrompt`:

```ts
    case "VEP":
      return buildVepPrompt(relevantText);
```

- [x] **Step 5: Correr y ver pasar**

Run: `npx vitest run src/lib/extraction.test.ts`
Expected: PASS

---

### Task 3: El VEP deja de ser un no-boleta

**Files:**
- Modify: `src/lib/documentClassifier.ts`
- Modify: `src/lib/documentClassifier.test.ts`

- [x] **Step 1: Vaciar la capa 0**

`detectDecisiveNotBoleta` se queda **sin ningún tipo**: `NotBoletaKind` pasa a `never`
y la función devuelve siempre `null`. **El mecanismo se conserva** —la firma, el gate
que la llama y su lugar en el pipeline— porque el día que aparezca otro formulario a
descartar se vuelve a llenar la lista sin rediseñar nada.

```ts
/** Tipos de documento que NO son boletas y se identifican sin ambigüedad. */
export type NotBoletaKind = never;

/**
 * Capa 0 del triage: tipos de documento **inequívocos**, que se descartan aunque
 * tengan todas las señales de una boleta.
 *
 * **Hoy está vacía.** Nació el 2026-08-31 con el VEP y el LSD; los dos salieron
 * después porque pasaron a procesarse (el LSD el 2026-09-01, el VEP el
 * 2026-09-03) y hoy los detecta el router de prompts. El mecanismo se conserva
 * para el próximo formulario que haya que descartar.
 */
export function detectDecisiveNotBoleta(_text: string): NotBoletaKind | null {
  return null;
}
```

Los marcadores y la constante de la ventana se borran de este archivo: viven ahora en
`extraction.ts` (Task 2, Step 4).

- [x] **Step 2: Actualizar los tests**

En `documentClassifier.test.ts`, el bloque `detectDecisiveNotBoleta` se reduce a fijar
que la capa quedó vacía, y los casos del VEP se borran (su cobertura pasó a
`extraction.test.ts`):

```ts
describe("detectDecisiveNotBoleta", () => {
  it("hoy no descarta ningún tipo: el VEP y el LSD pasaron a procesarse", () => {
    expect(detectDecisiveNotBoleta(VEP_REAL)).toBeNull();
    expect(detectDecisiveNotBoleta("FACTURA B 0001 CUIT 30-12345678-9 TOTAL $ 1000")).toBeNull();
  });
});
```

`VEP_REAL` ya existe en el archivo y se conserva como testigo.

- [x] **Step 3: Correr y ver pasar**

Run: `npx vitest run src/lib/documentClassifier.test.ts`
Expected: PASS

---

### Task 4: El pipeline no imputa el VEP a la administradora

> **Es la tarea que hace que la feature funcione.** `usesConsortiumCuit` habilita el match
> por nombre, pero `matchProvider` prueba **primero** por CUIT y `cuitSanitizeStep` le
> inyecta todos los CUITs del papel — incluido el de la administradora, que es un
> proveedor real con boletas propias. Ver la enmienda §3.2 del spec.

**Files:**
- Modify: `src/jobs/processPendingDocuments.job.ts`
- Test: `src/jobs/processPendingDocuments.job.test.ts` (los tests van en la Task 5)

- [x] **Step 1: Cortarle el CUIT al matching de proveedor**

En `resolveAssignment`, donde hoy dice:

```ts
const providerMatch = matchProvider(allProviders, rawCuit, rawName, allTaxIds, consortiumCuitNorm, isSindicalLsp);
```

```ts
// VEP: el papel trae el CUIT de "Generado por el Usuario" — la administradora, que es
// un proveedor real del consorcio con boletas propias de honorarios. Cualquier match
// por CUIT le imputa el gasto, y `cuitSanitizeStep` ya lo sumó a `allTaxIds` leyéndolo
// del texto, así que la regla del prompt no alcanza. El proveedor de un VEP es ARCA,
// siempre, y se resuelve por nombre.
const isVep = lspProvider === "VEP";
const providerMatch = matchProvider(
  allProviders,
  isVep ? null : rawCuit,
  rawName,
  isVep ? [] : allTaxIds,
  consortiumCuitNorm,
  isSindicalLsp
);
```

`allTaxIds` completo **sigue** yendo a `matchConsortium`: de ahí sale el edificio.

- [x] **Step 2: El consorcio del VEP, solo por CUIT**

Un VEP no imprime la dirección del inmueble, así que dejar viva la vía por nombre solo
habilita que un `consortium` mal extraído arrastre el gasto a otro edificio:

```ts
// El VEP no imprime dirección del inmueble: su único identificador es el CUIT del
// contribuyente. Habilitar el fuzzy por nombre solo abre la puerta a imputarlo mal.
const consortiumCuitOnly = isPlainInvoice || lspProvider === "VEP";
const consortiumMatch = matchConsortium(allConsortiums, rawConsortium, allTaxIds, consortiumCuitOnly);
```

Las etiquetas de Sin Asignar siguen colgadas de `isPlainInvoice` y no se tocan: las
cuatro etiquetas por CUIT hablan de un emisor que el VEP no tiene.

- [x] **Step 3: Que un `clientNumber` colado no rebote el documento**

El fast-path de `LspService` es terminal. Ninguno de los cinco `usesConsortiumCuit` usa
`LspService`, pero el guard actual solo cubre las no-LSP. En `cleanClientNumberStep`:

```ts
// Ninguna boleta del grupo `usesConsortiumCuit` (sindicales, ARCA, VEP) usa LspService.
// Un `Nro. VEP` colado acá por el modelo entraría al fast-path, que es terminal, y
// rebotaría el documento entero a Sin Asignar.
if ((!ctx.lspProvider || usesConsortiumCuit(ctx.lspProvider)) && extracted.clientNumber) {
```

- [x] **Step 4: Verificar que no se rompió nada**

Run: `npx vitest run src/jobs/processPendingDocuments.job.test.ts`
Expected: PASS — la red de caracterización sigue verde. Los sindicales y ARCA no cambian
de comportamiento: el Step 3 les limpia un campo que sus prompts ya fijan en `null`.

---

### Task 5: El VEP entra al consorcio correcto (integración)

**Files:**
- Modify: `src/jobs/processPendingDocuments.job.test.ts`

- [x] **Step 1: Escribir los tests que fallan**

```ts
describe("VEP de ARCA", () => {
  /** El CUIT del consorcio sembrado en makeContext + el de la administradora. */
  const VEP_TEXT = `VEP
Volante Electrónico de Pago
Nro. VEP: 1570130517
Organismo Recaudador: ARCA
Tipo de Pago: Empleadores SICOSS - Saldo DJ
CUIT: 30-11111111-1
Período: 2025-12
Generado por el Usuario: 27324998573
Día de Expiración: 2026-02-08
Importe total a pagar $1.123.728,00`;

  function vepContext() {
    const ctx = makeContext();
    ctx.pdfExtractor.extractTextFromPdf.mockResolvedValue(VEP_TEXT);
    // ARCA sin CUIT + la administradora, que es un proveedor real con CUIT.
    ctx.providerRepository.findAllForMatching.mockResolvedValue([
      { id: "arca", canonicalName: "ARCA", cuit: null, matchNames: null, paymentAlias: null },
      { id: "admin", canonicalName: "MORINIGO RAMONA NATALIA", cuit: "27-32499857-3", matchNames: null, paymentAlias: null },
    ]);
    ctx.aiChain.run.mockImplementation(async (_t: string, cb?: AiAttemptCallback) => {
      cb?.("gemini", true);
      return {
        data: emptyExtraction({
          boletaNumber: "1570130517",
          provider: "ARCA",
          providerTaxId: null,
          amount: 1123728,
          dueDate: "2026-02-08",
          allTaxIds: ["30-11111111-1"],
        }),
        usage: null,
        provider: "gemini" as const,
      };
    });
    return ctx;
  }

  it("imputa el gasto al consorcio del CUIT y el proveedor es ARCA", async () => {
    const ctx = vepContext();
    await processDriveFile(makeFile(), asContext(ctx), createBaseSummary(1));

    const guardada = ctx.invoiceRepository.saveProcessedInvoice.mock.calls[0][0];
    expect(guardada.consortiumId).toBe("c1");
    expect(guardada.providerId).toBe("arca");
  });

  it("NO imputa el gasto a la administradora, cuyo CUIT viaja en todos los VEP", async () => {
    const ctx = vepContext();
    await processDriveFile(makeFile(), asContext(ctx), createBaseSummary(1));

    const guardada = ctx.invoiceRepository.saveProcessedInvoice.mock.calls[0][0];
    expect(guardada.providerId).not.toBe("admin");
  });

  it("guarda el número, el monto y el vencimiento del cupón", async () => {
    const ctx = vepContext();
    await processDriveFile(makeFile(), asContext(ctx), createBaseSummary(1));

    const guardada = ctx.invoiceRepository.saveProcessedInvoice.mock.calls[0][0];
    expect(guardada.extraction.boletaNumber).toBe("1570130517");
    expect(guardada.extraction.amount).toBe(1123728);
    expect(guardada.extraction.dueDate).toBe("2026-02-08");
  });

  it("NO usa a la administradora aunque su CUIT llegue en allTaxIds", async () => {
    // Es lo que hace `cuitSanitizeStep`: extrae por regex TODOS los CUITs del papel y los
    // suma, así que este es el estado real en el que llega el matching. Sin el corte de
    // la Task 4, `matchProvider` devuelve `admin` por el Intento 0.
    const ctx = vepContext();
    ctx.aiChain.run.mockImplementation(async (_t: string, cb?: AiAttemptCallback) => {
      cb?.("gemini", true);
      return {
        data: emptyExtraction({
          boletaNumber: "1570130517",
          provider: "ARCA",
          providerTaxId: null,
          amount: 1123728,
          dueDate: "2026-02-08",
          allTaxIds: ["30-11111111-1", "27-32499857-3"],
        }),
        usage: null,
        provider: "gemini" as const,
      };
    });

    await processDriveFile(makeFile(), asContext(ctx), createBaseSummary(1));

    const guardada = ctx.invoiceRepository.saveProcessedInvoice.mock.calls[0][0];
    expect(guardada.providerId).toBe("arca");
    expect(guardada.consortiumId).toBe("c1");
  });

  it("un consortium mal extraído no arrastra el VEP a otro edificio", async () => {
    // El VEP no imprime la dirección del inmueble: lo que venga en `consortium` no es
    // una pista, es ruido. El match tiene que salir del CUIT o no salir.
    const ctx = vepContext();
    ctx.consortiumRepository.findAllForMatching.mockResolvedValue([
      { id: "c1", canonicalName: "ALMIRANTE BROWN 706", cuit: "30-11111111-1", matchNames: null },
      { id: "c2", canonicalName: "SICOSS 123", cuit: "30-22222222-2", matchNames: null },
    ]);
    ctx.aiChain.run.mockImplementation(async (_t: string, cb?: AiAttemptCallback) => {
      cb?.("gemini", true);
      return {
        data: emptyExtraction({
          boletaNumber: "1570130517",
          provider: "ARCA",
          consortium: "SICOSS 123",
          amount: 1123728,
          allTaxIds: ["30-11111111-1"],
        }),
        usage: null,
        provider: "gemini" as const,
      };
    });

    await processDriveFile(makeFile(), asContext(ctx), createBaseSummary(1));

    const guardada = ctx.invoiceRepository.saveProcessedInvoice.mock.calls[0][0];
    expect(guardada.consortiumId).toBe("c1");
  });

  it("un clientNumber colado por la IA no rebota el VEP al fast-path de LspService", async () => {
    const ctx = vepContext();
    ctx.aiChain.run.mockImplementation(async (_t: string, cb?: AiAttemptCallback) => {
      cb?.("gemini", true);
      return {
        data: emptyExtraction({
          boletaNumber: "1570130517",
          provider: "ARCA",
          clientNumber: "1570130517",
          amount: 1123728,
          allTaxIds: ["30-11111111-1"],
        }),
        usage: null,
        provider: "gemini" as const,
      };
    });

    await processDriveFile(makeFile(), asContext(ctx), createBaseSummary(1));

    expect(ctx.invoiceRepository.saveProcessedInvoice).toHaveBeenCalled();
    expect(ctx.driveService.moveFileToUnassigned).not.toHaveBeenCalled();
  });

  it("un VEP cuyo CUIT no es de ningún consorcio va a Sin Asignar", async () => {
    const ctx = vepContext();
    // El VEP de un proveedor o de una persona: su CUIT no es de un edificio.
    ctx.consortiumRepository.findAllForMatching.mockResolvedValue([]);
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
    expect(ctx.driveService.moveFileToUnassigned).toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Correr y ver pasar**

Run: `npx vitest run src/jobs/processPendingDocuments.job.test.ts`
Expected: PASS.

Estos tests son la red de la Task 4, no de `usesConsortiumCuit`. Si se corren **antes**
de la Task 4, el de la administradora falla: `matchProvider` encuentra su CUIT en
`allTaxIds` y devuelve `admin`. Vale correrlos así una vez para verlo fallar por la razón
correcta.

---

### Task 6: Verificación y documentación

- [x] **Step 1: Verificación completa**

Run: `npm run typecheck`
Run: `npx vitest run`
Run: `npm run lint`
Run: `npm run build:jobs`
Expected: 0 errores de typecheck y lint, todos los tests verdes.

- [x] **Step 2: Documentar**

- `docs/decisiones.md`: entrada del 2026-09-03 con el problema (el VEP se descartaba y
  su CUIT de administradora era una trampa), la decisión (`usesConsortiumCuit` + corte de
  `allTaxIds` en el matching de proveedor + prompt propio) y las alternativas descartadas
  (reusar `buildArcaPrompt`, ampliar la regla del 931). **Dejar asentado que
  `usesConsortiumCuit` por sí solo no neutraliza un CUIT ajeno**: solo habilita el match
  por nombre, que corre después del match por CUIT. Es el error que casi se implementa.
- `docs/progreso.md`: estado, los dos pendientes (VEP de terceros — **primario** — y
  VEP escaneado), y que la capa 0 del triage quedó vacía.
- `CHANGELOG.md`: entrada en `[Unreleased]`.
- `CLAUDE.md`: el VEP en la tabla de prompts y en el grupo de `usesConsortiumCuit`, con
  la aclaración de que en el VEP el matching de proveedor además ignora `allTaxIds`; y
  corregir la descripción del triage capa 0, que ya no descarta ningún tipo.

- [x] **Step 3: Avisar al owner**

Recordarle que para que el VEP aparezca en la hoja del edificio hace falta **un gasto
fijo con proveedor ARCA por cada consorcio con empleados**, y que el smoke es procesar
el VEP de ALMIRANTE BROWN y verificar monto `1.123.728,00`, vencimiento `2026-02-08` y
proveedor ARCA (no la administradora).
