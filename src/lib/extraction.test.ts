import { describe, it, expect } from "vitest";
import {
  identifyLSPProvider,
  buildExtractionPrompt,
  refineExtractionWithRawText,
  annotateSindicalProvider,
  usesConsortiumCuit,
} from "@/lib/extraction";
import type { ExtractedDocumentData } from "@/types/extractedDocument.types";

describe("annotateSindicalProvider", () => {
  it("anexa (SERACARH) cuando lspProvider es SERACARH (anexo de FATERYH)", () => {
    expect(annotateSindicalProvider("FATERYH", "SERACARH")).toBe("FATERYH (SERACARH)");
  });

  it("no toca el nombre para la boleta FATERYH normal", () => {
    expect(annotateSindicalProvider("FATERYH", "FATERYH")).toBe("FATERYH");
  });

  it("no toca otros proveedores (LSP o no-LSP)", () => {
    expect(annotateSindicalProvider("EDESUR S.A.", "EDESUR")).toBe("EDESUR S.A.");
    expect(annotateSindicalProvider("TIGRE ASCENSORES S.A.", null)).toBe("TIGRE ASCENSORES S.A.");
  });

  it("es idempotente: no duplica el sufijo si el nombre ya tiene SERACARH", () => {
    expect(annotateSindicalProvider("SERACARH", "SERACARH")).toBe("SERACARH");
    expect(annotateSindicalProvider("FATERYH (SERACARH)", "SERACARH")).toBe("FATERYH (SERACARH)");
  });

  it("provider null → null", () => {
    expect(annotateSindicalProvider(null, "SERACARH")).toBeNull();
  });
});

// Encabezados REALES extraídos de los PDFs de muestra (pdf-parse, texto plano).
const SUTERH_TEXT = [
  "SINDICATO UNICO DE TRABAJADORES DE EDIFICIOS DE RENTA Y HORIZONTAL F0201",
  "CUIT: 30-54675623-4 (24264)",
  "CONSORCIO: AVDA BOEDO 00410 /14-CIUDAD DE BUENOS AIRES-",
  "CAPITAL FEDERAL",
  "PERIODO: 05/2026 DECLARACION: 0 - Original",
  "Nº BOLETA: 26-00240005 VENCIMIENTO: 12/06/2026",
  "CPF aporte 20619.07 0.00 20619.07",
  "Aporte sindical 41238.14 0.00 41238.14",
  "TOTAL A PAGAR: 92785.81",
  "ESTA BOLETA SE DEBITARA DIRECTAMENTE EN SU CUENTA BANCARIA INFORMADA.",
].join("\n");

const FATERYH_TEXT = [
  "FEDERACION ARGENTINA DE TRABAJADORES DE EDIFICIOS DE RENTA Y HORIZONTAL F0101",
  "CUIT: 30-54675623-4 (24264) 2/2",
  "CONSORCIO: AVDA BOEDO 00410 /14-CIUDAD DE BUENOS AIRES-",
  "PERIODO: 05/2026 DECLARACION: 0 - Original",
  "Nº BOLETA: 26-00294395 VENCIMIENTO: 12/06/2026",
  "FMVDD aporte 20619.07 0.00 20619.07",
  "Contrib. Solidaria OS CCT 589/10 44962.00 0.00 44962.00",
  "TOTAL A PAGAR: 178985.95",
].join("\n");

const SERACARH_TEXT = [
  "FEDERACION ARGENTINA DE TRABAJADORES DE EDIFICIOS DE RENTA Y HORIZONTAL F0106",
  "CUIT: 30-54675623-4 (24264) 1/2",
  "CONSORCIO: AVDA BOEDO 00410 /14-CIUDAD DE BUENOS AIRES-",
  "PERIODO: 05/2026 DECLARACION: 0 - Original",
  "Nº BOLETA: 26-00284923 VENCIMIENTO: 12/06/2026",
  "SERACARH Contribución 10309.53 0.00 10309.53",
  "TOTAL A PAGAR: 10309.53",
].join("\n");

// ARCA F931 (SUSS) REAL: la DJ (pág.1) trae el CUIT del CONSORCIO y los montos
// desglosados; el VEP (pág.2) trae el "Importe total a pagar".
const ARCA_TEXT = [
  "931",
  "Declaración Jurada en Pesos con centavos",
  "S.U.S.S.",
  "C.U.I.T. 30-68835011-1",
  "Mes - Año 05/2026",
  "Apellido y Nombre o Razón Social:",
  "CONSORCIO DE PROPIETARIOS AV BELGRANO 2458 AL 2462",
  "VIII - MONTOS QUE SE INGRESAN",
  "-- 1 of 3 --",
  "VEP",
  "Volante Electrónico de Pago",
  "Nro. VEP: 1641803730",
  "Organismo Recaudador: ARCA",
  "CUIT: 30-68835011-1",
  "Período: 2026-05",
  "Importe total a pagar $453.493,06",
  "Día de Expiración: 2026-07-18",
].join("\n");

describe("identifyLSPProvider — boletas sindicales (SUTERH/FATERYH/SERACARH)", () => {
  it("detecta SUTERH (F0201 / Sindicato Único)", () => {
    expect(identifyLSPProvider(SUTERH_TEXT)).toBe("SUTERH");
  });

  it("detecta FATERYH (F0101 / Federación)", () => {
    expect(identifyLSPProvider(FATERYH_TEXT)).toBe("FATERYH");
  });

  it("detecta SERACARH (F0106, emitida por FATERYH)", () => {
    expect(identifyLSPProvider(SERACARH_TEXT)).toBe("SERACARH");
  });

  it("regresión: una factura común sigue sin ser LSP", () => {
    const factura = "FACTURA C\nLUZARDO JAVIEL JOSE EMILIO\nCUIT: 20940370362\nImporte Total: 50000";
    expect(identifyLSPProvider(factura)).toBeNull();
  });

  it("regresión: Edesur sigue detectándose", () => {
    expect(identifyLSPProvider("EDESUR S.A. Liquidación de Servicios Públicos")).toBe("EDESUR");
  });
});

/**
 * Texto real de una boleta de ABL (AGIP), tal como lo devuelve pdf-parse.
 * Reproducido literal: 737 caracteres, sin CUIT, sin nombre ni dirección del
 * inmueble. La PARTIDA es el único identificador.
 */
const ABL_TEXT = [
  "INMOBILIARIO Y ABL",
  "PARTIDA",
  "CÓDIGO PARA PAGO ELECTRÓNICO",
  "3755690",
  "007-003755690-1",
  "CUOTA 06 - JUNIO - AÑO 2026",
  "05/06/2026 $ 1,101,687.79",
  "30/06/2026 $ 1,249,084.96",
  "Impuesto Inmobiliario / Alumbrado, Barrido, Limpieza,",
  "Mantenimiento y Conservación de Sumideros.",
  "Ley 23.514/1987",
  "2° VTO.",
  "1° VTO.",
].join("\n");

describe("identifyLSPProvider — ABL / Impuesto Inmobiliario (AGIP)", () => {
  it("detecta ABL en una boleta real", () => {
    expect(identifyLSPProvider(ABL_TEXT)).toBe("ABL");
  });

  it("detecta ABL por la Ley 23.514 aunque falte el par Alumbrado/Barrido", () => {
    expect(identifyLSPProvider("GOBIERNO DE LA CIUDAD\nLey 23.514/1987\nPARTIDA 123")).toBe("ABL");
  });

  it("detecta ABL por el par Alumbrado + Barrido", () => {
    expect(identifyLSPProvider("Alumbrado, Barrido y Limpieza\nPARTIDA 999")).toBe("ABL");
  });

  it("NO usa el CUIT del papel: el ABL queda fuera del grupo consorcio-CUIT", () => {
    // El ABL sí usa LspService (la partida hace de número de cliente), a
    // diferencia de los sindicales, que se excluyen del fast-path.
    expect(usesConsortiumCuit("ABL")).toBe(false);
  });

  it("regresión: una factura común no se confunde con ABL", () => {
    expect(identifyLSPProvider("FACTURA B\nSERVICIOS DE LIMPIEZA SRL\nCUIT 30-11111111-2")).toBeNull();
  });
});

describe("buildExtractionPrompt — ABL", () => {
  const prompt = buildExtractionPrompt(ABL_TEXT);

  it("instruye tomar la PARTIDA como clientNumber", () => {
    expect(prompt).toContain("PARTIDA");
    expect(prompt).toContain("clientNumber");
  });

  it("instruye el 1° vencimiento y descarta el 2°", () => {
    expect(prompt).toContain("1° VENCIMIENTO");
    expect(prompt).toContain("recargo");
  });

  it("prohibe asignar un providerTaxId", () => {
    expect(prompt).toContain("providerTaxId: null SIEMPRE");
  });

  it("construye el boletaNumber como partida-MM/YYYY", () => {
    expect(prompt).toContain("3755690-06/2026");
  });
});

describe("identifyLSPProvider — ARCA (F931 / SUSS)", () => {
  it("detecta ARCA por formulario 931 + S.U.S.S.", () => {
    expect(identifyLSPProvider(ARCA_TEXT)).toBe("ARCA");
  });

  it("no confunde una boleta sindical (FATERYH) con ARCA", () => {
    expect(identifyLSPProvider(FATERYH_TEXT)).toBe("FATERYH");
  });

  it("regresión: una factura común con un '931' suelto NO es ARCA", () => {
    // Sin S.U.S.S. ni 'Organismo Recaudador' no debe matchear ARCA.
    expect(identifyLSPProvider("FACTURA B N° 0931-00000001\nImporte Total: 5000")).toBeNull();
  });
});

describe("usesConsortiumCuit (el CUIT del papel es del consorcio, proveedor por nombre)", () => {
  it("true para sindicales y ARCA", () => {
    expect(usesConsortiumCuit("SUTERH")).toBe(true);
    expect(usesConsortiumCuit("FATERYH")).toBe(true);
    expect(usesConsortiumCuit("SERACARH")).toBe(true);
    expect(usesConsortiumCuit("ARCA")).toBe(true);
  });

  it("false para servicios públicos y null", () => {
    expect(usesConsortiumCuit("EDESUR")).toBe(false);
    expect(usesConsortiumCuit("AYSA")).toBe(false);
    expect(usesConsortiumCuit(null)).toBe(false);
  });
});

describe("buildExtractionPrompt — ARCA", () => {
  it("rutea ARCA a su prompt específico (total del VEP, provider ARCA)", () => {
    const prompt = buildExtractionPrompt(ARCA_TEXT);
    expect(prompt).toMatch(/ARCA/);
    expect(prompt).toMatch(/Importe total a pagar/i);
    expect(prompt).toMatch(/VEP/);
  });

  it("incluye el total del VEP aunque esté más allá de la línea 80 (la DJ es larga)", () => {
    // Caso real: el "Importe total a pagar" del VEP cae ~línea 88 de la DJ+VEP.
    // Antes el prompt se cortaba a 80 líneas → la IA no veía el total y lo inventaba.
    const filler = Array.from({ length: 90 }, (_, i) => `Concepto ${i}: 0,00`);
    const longArca = [
      "931",
      "S.U.S.S.",
      "C.U.I.T. 30-68835011-1",
      "CONSORCIO DE PROPIETARIOS AV BELGRANO 2458 AL 2462",
      ...filler,
      "VEP",
      "Organismo Recaudador: ARCA",
      "Importe total a pagar $453.493,06",
    ].join("\n");
    expect(identifyLSPProvider(longArca)).toBe("ARCA");
    expect(buildExtractionPrompt(longArca)).toMatch(/453\.493,06/);
  });

  it("el prompt prohíbe sumar/inventar el monto (copiar literal del VEP, null si no está)", () => {
    const prompt = buildExtractionPrompt(ARCA_TEXT);
    expect(prompt).toMatch(/PROHIBIDO sumar/i);
    expect(prompt).toMatch(/no inventes/i);
  });
});

describe("identifyLSPProvider — falso positivo de PERSONAL", () => {
  // Factura de IPLAN (NSS SA): dice 'CÓDIGO DE GESTIÓN PERSONAL', pero NO es
  // Telecom/Personal. Antes el router la clasificaba como PERSONAL (por la
  // palabra suelta) → la trataba como LSP, buscaba nro de cliente y caía en
  // Sin Asignar. Debe ser factura común (null) → matchea NSS SA por CUIT.
  const IPLAN = [
    "FACTURA A CÓDIGO N°: 1",
    "NSS SA",
    "Internet Giga+ Abono 107761.69",
    "CONS DE PROPS DE LA CALLE BME MITRE 1223 Y 1225",
    "CUIT 30702652975",
    "CLIENTE N° 664688",
    "CÓDIGO DE GESTIÓN PERSONAL: 6646881",
  ].join("\n");

  it("NO detecta PERSONAL en una factura de IPLAN (solo 'GESTIÓN PERSONAL')", () => {
    expect(identifyLSPProvider(IPLAN)).toBeNull();
  });

  it("sigue detectando Personal/Telecom real (TELECOM ARGENTINA)", () => {
    const personal = "TELECOM ARGENTINA S.A.\nFactura Personal\nN° de Referencia de Pago 12345";
    expect(identifyLSPProvider(personal)).toBe("PERSONAL");
  });

  it("sigue detectando Personal cuando la marca aparece sola (no 'gestión personal')", () => {
    const personal = "MI PERSONAL\nFactura de telefonía\nVencimiento para el pago";
    expect(identifyLSPProvider(personal)).toBe("PERSONAL");
  });
});

describe("buildExtractionPrompt — prompt sindical", () => {
  // El proveedor sindical se identifica por NOMBRE (del encabezado). El CUIT que
  // figura en el documento es del CONSORCIO/edificio contribuyente (cada edificio
  // tiene el suyo), NO del proveedor → providerTaxId debe ser null y el CUIT va a
  // allTaxIds para matchear el edificio.
  it("para SUTERH fija provider por nombre y NO le asigna CUIT al proveedor", () => {
    const prompt = buildExtractionPrompt(SUTERH_TEXT);
    expect(prompt).toContain("provider: siempre 'SUTERH'");
    expect(prompt).toContain("providerTaxId: null");
    expect(prompt).not.toContain("providerTaxId: siempre '30-54675623-4'");
  });

  it("para SERACARH fija provider SERACARH (no FATERYH)", () => {
    const prompt = buildExtractionPrompt(SERACARH_TEXT);
    expect(prompt).toContain("provider: siempre 'SERACARH'");
    expect(prompt).toContain("providerTaxId: null");
  });

  it("para FATERYH fija provider FATERYH", () => {
    const prompt = buildExtractionPrompt(FATERYH_TEXT);
    expect(prompt).toContain("provider: siempre 'FATERYH'");
  });

  it("instruye que el CUIT del documento es del consorcio (va a allTaxIds)", () => {
    const prompt = buildExtractionPrompt(SUTERH_TEXT);
    expect(prompt).toContain("allTaxIds");
    expect(prompt.toLowerCase()).toContain("consorcio");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Refinamiento del consorcio receptor en facturas comunes
// ───────────────────────────────────────────────────────────────────────────

function makeExtracted(partial: Partial<ExtractedDocumentData>): ExtractedDocumentData {
  return {
    boletaNumber: null,
    provider: null,
    consortium: null,
    providerTaxId: null,
    detail: null,
    observation: null,
    dueDate: null,
    amount: null,
    alias: null,
    clientNumber: null,
    paymentMethod: null,
    allTaxIds: null,
    ...partial,
  };
}

// Texto REAL extraído de "MAYO 2026.pdf" (pdf-parse): factura C de un proveedor
// de desinsectación. El receptor es el CONSORCIO DE PROPIETARIOS de CORONEL DIAZ
// 1714, SIN etiqueta "Cliente:" y con CUIT placeholder 00-00000000-0 (consumidor
// final) → el match solo puede ser por nombre. La única "Razón Social:" rotulada
// es la del EMISOR (el proveedor), lo que confunde a la IA y al refinamiento.
const FACTURA_C_DESINSECTACION = [
  "CORRESPONDIENTE AL MES DE: MAYO",
  "Punto de Venta: 0003 Comp.Nro: 00001508",
  "Fecha de Emisión: 02/06/2026",
  "Razón Social: SEBASTIAN ISMAEL CABRERA",
  "Domicilio Comercial: SAN NICOLAS 1234 CUIT: 20-31791625-7",
  "1407 CAPITAL FEDERAL Ingresos Brutos: 20-31791625-7",
  "Fecha Inicio de Actividades: 01/02/2014",
  "01/06/2026 30/06/2026 30/06/2026",
  "00-00000000-0 CONSORCIO DE PROPIETARIOS",
  "CONSUMIDOR FINAL CORONEL DIAZ 1714",
  "C.A.B.A.",
  "SERVICIO DE DESINSECTACION DEL EDIFICIO. 70000,00",
].join("\n");

describe("refineExtractionWithRawText — consorcio receptor en facturas comunes", () => {
  it("corrige el consorcio al receptor real cuando la IA tomó el emisor", () => {
    const refined = refineExtractionWithRawText(
      makeExtracted({ provider: "SEBASTIAN ISMAEL CABRERA", consortium: "SEBASTIAN ISMAEL CABRERA" }),
      FACTURA_C_DESINSECTACION
    );
    expect(refined.consortium).toMatch(/CORONEL DIAZ 1714/i);
    expect(refined.consortium ?? "").not.toMatch(/CABRERA/i);
  });

  it("no degrada un consorcio bien extraído al nombre del emisor", () => {
    const refined = refineExtractionWithRawText(
      makeExtracted({ provider: "SEBASTIAN ISMAEL CABRERA", consortium: "CORONEL DIAZ 1714" }),
      FACTURA_C_DESINSECTACION
    );
    expect(refined.consortium).toMatch(/CORONEL DIAZ 1714/i);
    expect(refined.consortium ?? "").not.toMatch(/CABRERA/i);
  });

  it("enriquece 'CONSORCIO DE PROPIETARIOS' pelado con la dirección del receptor", () => {
    const refined = refineExtractionWithRawText(
      makeExtracted({ consortium: "CONSORCIO DE PROPIETARIOS" }),
      FACTURA_C_DESINSECTACION
    );
    expect(refined.consortium).toMatch(/CORONEL DIAZ 1714/i);
  });

  it("no infiere consorcio si el texto no tiene marcador de consorcio (respeta a la IA)", () => {
    const sinMarcador = [
      "Razón Social: FERRETERIA SAN JUAN SRL",
      "CUIT: 30-11111111-2",
      "Cliente: JUAN PEREZ",
      "Total: 5000",
    ].join("\n");
    const refined = refineExtractionWithRawText(
      makeExtracted({ provider: "FERRETERIA SAN JUAN SRL", consortium: "JUAN PEREZ" }),
      sinMarcador
    );
    expect(refined.consortium).toBe("JUAN PEREZ");
  });
});

describe("refineExtractionWithRawText — guard de IVA contenido (Ley 27.743)", () => {
  // Caso real: boleta 0003-00161074 (RANKO). Los rótulos del régimen quedan vacíos
  // y sus valores caen sueltos más abajo — así lineariza pdf-parse este PDF.
  const FACTURA_LEY_27743 = [
    "Régimen de Transparencia Fiscal al Consumidor (Ley 27.743)",
    "IVA Contenido: $",
    "Otros Impuestos Nacionales Indirectos: $",
    "FACTURA",
    "CONSORCIO DE PROPIETARIOS BARTOLOME MITRE 1225",
    "1.00 SERVICIO DE MANTENIMIENTO ANUAL DE LOS EXTINTORES 360706.09 360706.09",
    "62601.88",
    "0.00 360706.09",
  ].join("\n");

  it("corrige el monto cuando la IA tomó el IVA contenido como total", () => {
    const refined = refineExtractionWithRawText(
      makeExtracted({ amount: 62601.88 }),
      FACTURA_LEY_27743
    );
    expect(refined.amount).toBe(360706.09);
  });

  it("no toca el monto si la IA extrajo el total correcto", () => {
    const refined = refineExtractionWithRawText(
      makeExtracted({ amount: 360706.09 }),
      FACTURA_LEY_27743
    );
    expect(refined.amount).toBe(360706.09);
  });

  it("NO aplica el guard a boletas LSP (ahí el monto correcto es el 1er vencimiento, no el máximo)", () => {
    // Boleta de servicio público con dos vencimientos: el correcto (menor) NO debe
    // ser reemplazado por el del segundo vencimiento con recargo.
    const lsp = [
      "EDESUR S.A.",
      "Régimen de Transparencia Fiscal al Consumidor (Ley 27.743)",
      "IVA Contenido: $",
      "NUMERO DE CLIENTE: 12345",
      "Total a pagar hasta 18/02/2026 121670.97",
      "Fecha límite de pago en banco 23/02/2026 122078.88",
    ].join("\n");
    const refined = refineExtractionWithRawText(makeExtracted({ amount: 121670.97 }), lsp);
    expect(refined.amount).toBe(121670.97);
  });
});

describe("buildInvoicePrompt — identificación del consorcio receptor", () => {
  it("instruye reconocer 'CONSORCIO DE PROPIETARIOS' + dirección como el receptor", () => {
    // Input neutro que NO contiene la frase, para que el assert valide la
    // INSTRUCCIÓN del prompt y no el eco del texto de entrada.
    const prompt = buildExtractionPrompt("Factura B\nProveedor XYZ SA\nCUIT: 30-11111111-2\nTotal: 100");
    expect(prompt).toContain("CONSORCIO DE PROPIETARIOS");
  });
});

describe("identifyLSPProvider — Liquidación de Sueldos Digital (LSD)", () => {
  /** Encabezado real de un LSD (ALMIRANTE BROWN 706, julio 2026), recortado. */
  const LSD_TEXT = `EMPRESA DOMICILIO FISCAL
PERIODO PROVINCIA
NRO.LIQUIDACIÓN
ACTIVIDAD PPAL
30-52063978-7 - CONSORCIO COPROPIETARIOS AV ALMIRANTE B BROWN ALMTE AV. 706 06A
202607 CIUDAD AUTONOMA BUENOS AIRES
949920 - SERVICIOS DE CONSORCIOS DE EDIFICIOS
LEGAJO CUIL APELLIDO Y NOMBRE FECHA INGRESO FECHA CESE DOCUMENTO
IDENTIFICADOR ÚNICO DEL LIBRO 000000045900718 FECHA DE EMISIÓN DEL LIBRO 07/08/2026`;

  it("identifica un LSD por el encabezado del libro", () => {
    expect(identifyLSPProvider(LSD_TEXT)).toBe("LSD");
  });

  it("gana sobre el falso positivo FATERYH del convenio colectivo", () => {
    // El LSD nombra el convenio de la federación en la fila del empleado; sin la
    // detección temprana el router lo mandaba al prompt sindical.
    const conConvenio = `${LSD_TEXT}
008 - A tiempo completo indeterminado 0589/10 - FEDERACIÓN ARGENTINA TRABAJADORES DE EDIF.DE RENTA Y PROPIED`;
    expect(identifyLSPProvider(conConvenio)).toBe("LSD");
  });

  it("un F931 de ARCA NO se identifica como LSD", () => {
    const f931 = "ARCA F. 931 S.U.S.S. CUIT 30-52063978-7 Total contribuciones $ 1.200.000";
    expect(identifyLSPProvider(f931)).not.toBe("LSD");
  });

  it("una factura común no se identifica como LSD", () => {
    expect(identifyLSPProvider("FACTURA B 0001 CUIT 30-12345678-9 TOTAL $ 1000 CAE 123")).toBeNull();
  });

  it("buildExtractionPrompt rutea un LSD a su prompt propio", () => {
    const prompt = buildExtractionPrompt(LSD_TEXT);
    expect(prompt).toContain("LIQUIDACIÓN DE SUELDOS DIGITAL");
    expect(prompt).toContain("sueldoNeto");
  });
});

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
