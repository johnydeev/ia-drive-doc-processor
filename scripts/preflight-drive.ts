/**
 * scripts/preflight-drive.ts
 * DIAGNÓSTICO READ-ONLY, SIN IA: recorre Pendientes y Sin Asignar en Drive y, para cada
 * PDF, dice si va a matchear consorcio / proveedor / LspService contra el directorio
 * actual de la base. Sirve para saber qué falta dar de alta ANTES de gastar requests.
 *
 * Reproduce la lógica de asignación del pipeline (CUIT del consorcio, CUIT del emisor,
 * nombre para el grupo `usesConsortiumCuit`, número de cliente para servicios) pero es
 * una aproximación: el número de cliente se busca por presencia en el texto, no lo
 * extrae la IA. Un "OK" acá es casi seguro; un "REBOTA" es seguro.
 *
 * No modifica nada. Solo lee Drive y la base.
 *
 * Uso:
 *   npx tsx scripts/preflight-drive.ts                     (default: MorinigoAdm, Pendientes + Sin Asignar)
 *   npx tsx scripts/preflight-drive.ts --name=OtroCliente
 *   npx tsx scripts/preflight-drive.ts --folders=unassigned          (pending | unassigned | failed, separados por coma)
 *   npx tsx scripts/preflight-drive.ts --texto=C:\tmp\textos         (además vuelca el texto de cada PDF a esa carpeta)
 *
 * Nota: en una PC sin `pdftoppm` el OCR de respaldo falla y los escaneos quedan con el
 * texto directo (normalmente vacío). En el contenedor de producción sí está.
 */
import fs from "fs";
import path from "path";
import { getPrismaClient } from "@/lib/prisma";
import { loadProcessingClient, resolveGoogleConfig } from "@/lib/clientProcessingConfig";
import { GoogleDriveService } from "@/services/googleDrive.service";
import { PdfTextExtractorService } from "@/services/pdfTextExtractor.service";
import { extractCuitsFromText, cuitDigits } from "@/lib/cuit";
import { identifyLSPProvider, usesConsortiumCuit } from "@/lib/extraction";
import { detectDecisiveNotBoleta, classifyDocumentType } from "@/lib/documentClassifier";

type Row = {
  carpeta: string;
  archivo: string;
  url: string;
  tipo: string;
  consorcio: string;
  proveedor: string;
  lsp: string;
  veredicto: string;
};

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const clientName = arg("name") ?? "MorinigoAdm";
  const folderKeys = (arg("folders") ?? "pending,unassigned").split(",").map((s) => s.trim());
  const textoDir = arg("texto");
  if (textoDir) fs.mkdirSync(textoDir, { recursive: true });

  const prisma = getPrismaClient();
  const client = await prisma.client.findFirst({ where: { name: clientName } });
  if (!client) throw new Error(`Cliente ${clientName} no existe`);
  const pc = await loadProcessingClient(client.id);
  if (!pc) throw new Error("Cliente sin configuración de procesamiento");
  const folders = (pc.driveFoldersJson ?? {}) as Record<string, string | undefined>;
  const drive = new GoogleDriveService(resolveGoogleConfig(pc));
  const extractor = new PdfTextExtractorService();

  const consortiums = await prisma.consortium.findMany({ where: { clientId: client.id } });
  const providers = await prisma.provider.findMany({ where: { clientId: client.id } });
  const lsps = await prisma.lspService.findMany({
    where: { clientId: client.id },
    include: { consortium: true },
  });

  // CUIT del consorcio (más los alternativos de matchNames) → nombre canónico
  const consByCuit = new Map<string, string>();
  for (const c of consortiums) {
    if (c.cuit) consByCuit.set(cuitDigits(c.cuit), c.canonicalName);
    for (const alt of (c.matchNames ?? "").split("|")) {
      const d = alt.replace(/\D/g, "");
      if (d.length === 11) consByCuit.set(d, c.canonicalName);
    }
  }
  const provByCuit = new Map<string, string>();
  for (const p of providers) if (p.cuit) provByCuit.set(cuitDigits(p.cuit), p.canonicalName);
  const provByName = (needle: string): string | null => {
    const upper = needle.toUpperCase();
    const hit = providers.find((p) =>
      `${p.canonicalName}|${p.matchNames ?? ""}`
        .toUpperCase()
        .split("|")
        .some((n) => n.trim() && upper.includes(n.trim()))
    );
    return hit?.canonicalName ?? null;
  };

  const rows: Row[] = [];

  for (const key of folderKeys) {
    const folderId = folders[key];
    if (!folderId) {
      console.error(`carpeta "${key}" no configurada en driveFoldersJson — se saltea`);
      continue;
    }
    const files = await drive.listPdfFilesInFolder(folderId);
    console.error(`${key}: ${files.length} archivo(s)`);

    for (const f of files) {
      const row: Row = {
        carpeta: key,
        archivo: f.name,
        url: f.webViewLink ?? "",
        tipo: "",
        consorcio: "",
        proveedor: "",
        lsp: "",
        veredicto: "",
      };
      rows.push(row);
      try {
        const buf = await drive.downloadFile(f.id);
        const text = await extractor.extractTextFromPdf(buf);
        if (textoDir) {
          const safe = f.name.replace(/[^\w.-]+/g, "_");
          fs.writeFileSync(path.join(textoDir, `${safe}.txt`), `URL: ${row.url}\n\n${text}`);
        }

        const notB = detectDecisiveNotBoleta(text);
        if (notB) {
          row.tipo = `NO BOLETA ${notB}`;
          row.veredicto = "Sin Asignar [NO BOLETA]";
          continue;
        }
        if (classifyDocumentType(text) === "not_boleta") {
          row.tipo = "NO BOLETA (capa 1)";
          row.veredicto = "Sin Asignar [NO BOLETA]";
          continue;
        }

        const lsp = identifyLSPProvider(text);
        row.tipo = lsp ?? "FACTURA";
        const cuits = extractCuitsFromText(text).map(cuitDigits);
        const consCuits = new Set(cuits.filter((c) => consByCuit.has(c)));
        const consHits = [...new Set([...consCuits].map((c) => consByCuit.get(c)!))];
        row.consorcio = consHits.length
          ? consHits.join("/")
          : cuits.length
            ? `NO (CUITs: ${[...new Set(cuits)].join(",")})`
            : "sin CUIT en texto";

        if (lsp === "LIQ_RETENCION" || lsp === "VEP_RETENCION" || lsp === "VEP_MIXTO") {
          row.proveedor = lsp === "LIQ_RETENCION" ? "paquete (regex)" : "-";
          row.veredicto =
            lsp === "LIQ_RETENCION"
              ? consHits.length
                ? "OK si el parser lee la planilla"
                : "Revisión: consorcio no matchea"
              : `Revisión [${lsp}]`;
          continue;
        }
        if (lsp === "LSD") {
          const cuils = [...new Set(cuits.filter((c) => !consByCuit.has(c)))];
          const faltan = cuils.filter((c) => !provByCuit.has(c));
          row.proveedor = `empleados por CUIL — ${faltan.length ? `FALTAN ${faltan.join(",")}` : "todos cargados"}`;
          row.veredicto = consHits.length && !faltan.length ? "OK" : "REBOTA";
          continue;
        }
        if (usesConsortiumCuit(lsp)) {
          const name = lsp === "VEP" ? "ARCA EMPLEADO" : (lsp as string);
          const p = provByName(name);
          row.proveedor = p ? `${p} (por nombre)` : `NO hay proveedor ${name}`;
          row.veredicto = consHits.length && p ? "OK" : "REBOTA";
          continue;
        }
        if (lsp) {
          // Servicio: el vínculo real lo da el número de cliente contra LspService.
          const digits = text.replace(/[\s.\-/]/g, "");
          const family = lsp.split("_")[0];
          const hits = lsps.filter((s) => {
            const n = s.clientNumber.replace(/\D/g, "");
            return s.providerName.toUpperCase().includes(family) && n.length >= 5 && digits.includes(n);
          });
          row.proveedor = lsp;
          row.lsp = hits.length
            ? hits.map((h) => `${h.consortium.canonicalName} ${h.clientNumber}`).join(" / ")
            : "NRO CLIENTE NO REGISTRADO";
          row.veredicto = hits.length ? "OK (por nro cliente)" : "REBOTA [LSP SIN REGISTRAR]";
          continue;
        }

        // Factura común: proveedor por CUIT del emisor (cualquier CUIT que no sea del consorcio).
        const provCuits = [...new Set(cuits.filter((c) => !consCuits.has(c)))];
        const provHits = provCuits.filter((c) => provByCuit.has(c)).map((c) => provByCuit.get(c)!);
        row.proveedor = provHits.length
          ? provHits.join("/")
          : provCuits.length
            ? `NO REGISTRADO (${provCuits.join(",")})`
            : "sin CUIT de proveedor en texto";
        if (consHits.length && provHits.length) row.veredicto = "OK";
        else if (!consHits.length)
          row.veredicto = `REBOTA [CUIT DE CONSORCIO ${cuits.length ? "NO REGISTRADO" : "INEXISTENTE"}]`;
        else row.veredicto = `REBOTA [CUIT DE PROVEEDOR ${provCuits.length ? "NO REGISTRADO" : "INEXISTENTE"}]`;
      } catch (e) {
        row.veredicto = `ERROR ${(e as Error).message.slice(0, 80)}`;
      }
    }
  }

  console.log("");
  for (const r of rows) {
    console.log(
      [r.carpeta, r.archivo, r.tipo, r.consorcio, r.proveedor, r.lsp, r.veredicto]
        .filter((x) => x !== "")
        .join(" | ")
    );
  }
  const rebotan = rows.filter((r) => !r.veredicto.startsWith("OK")).length;
  console.log(`\n${rows.length} archivo(s), ${rows.length - rebotan} entran, ${rebotan} rebotan.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
