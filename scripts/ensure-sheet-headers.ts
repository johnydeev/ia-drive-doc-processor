/**
 * scripts/ensure-sheet-headers.ts
 * Completa los encabezados FALTANTES de la hoja de Datos de un cliente (fila 1),
 * sin pisar los que ya existen. Útil para hojas viejas a las que se les
 * agregaron columnas después (ej. las de pagos: BANCO, SALDO PENDIENTE, MONTO
 * PAGADO, CANT CUOTAS, FECHA PAGO, URL COMPROBANTE, MEDIO PAGO).
 *
 * Uso:
 *   npx tsx scripts/ensure-sheet-headers.ts <clientId|nombre|email>
 *
 * Ejemplos:
 *   npx tsx scripts/ensure-sheet-headers.ts MorinigoAdm
 *   npx tsx scripts/ensure-sheet-headers.ts cmmuvg0hl0000kxl4ks5nrgxn
 */

import "@/lib/loadEnv";
import { getPrismaClient } from "@/lib/prisma";
import { GoogleSheetsService, SheetsRowMapping } from "@/services/googleSheets.service";
import {
  loadProcessingClient,
  resolveGoogleConfig,
  resolveMapping,
  resolveSheetName,
} from "@/lib/clientProcessingConfig";

const DEFAULT_MAPPING: SheetsRowMapping = {
  boletaNumber: "A",
  provider: "B",
  consortium: "C",
  providerTaxId: "D",
  detail: "E",
  observation: "F",
  dueDate: "G",
  amount: "H",
  alias: "I",
  clientNumber: "J",
  sourceFileUrl: "K",
  isDuplicate: "L",
  period: "M",
  paymentStatus: "N",
  bank: "O",
  remainingBalance: "P",
  paidAmount: "Q",
  installmentsCount: "R",
  paymentDate: "S",
  receiptUrl: "T",
  paidWith: "U",
};

async function main() {
  const query = process.argv[2];
  if (!query) {
    console.error("Falta el cliente. Uso: npx tsx scripts/ensure-sheet-headers.ts <clientId|nombre|email>");
    process.exit(1);
  }

  const prisma = getPrismaClient();

  // Resolver el cliente por id, email o nombre (case-insensitive, parcial).
  const client =
    (await prisma.client.findUnique({ where: { id: query } }).catch(() => null)) ??
    (await prisma.client.findFirst({
      where: {
        OR: [
          { email: { equals: query, mode: "insensitive" } },
          { name: { contains: query, mode: "insensitive" } },
        ],
      },
    }));

  if (!client) {
    console.error(`No se encontró un cliente para "${query}".`);
    process.exit(1);
  }

  const processingClient = await loadProcessingClient(client.id);
  if (!processingClient) {
    console.error(`No se pudo cargar la config de procesamiento del cliente ${client.name}.`);
    process.exit(1);
  }

  const googleConfig = resolveGoogleConfig(processingClient);
  if (!googleConfig) {
    console.error("Credenciales de Google incompletas para este cliente.");
    process.exit(1);
  }

  const sheetName = resolveSheetName(processingClient);
  const mapping = resolveMapping(processingClient) ?? DEFAULT_MAPPING;
  const sheets = new GoogleSheetsService(googleConfig);

  console.log(`Cliente: ${client.name} <${client.email}>`);
  console.log(`Hoja de Datos: "${sheetName}"`);

  const added = await sheets.ensureHeaders(sheetName, mapping);

  if (added.length === 0) {
    console.log("✓ Todos los encabezados ya estaban completos. No se cambió nada.");
  } else {
    console.log(`✓ Encabezados agregados (${added.length}): ${added.join(", ")}`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
