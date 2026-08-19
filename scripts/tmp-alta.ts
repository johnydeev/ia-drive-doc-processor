import { loadEnv } from "@/lib/loadEnv";
import { getPrismaClient } from "@/lib/prisma";
import { loadProcessingClient, resolveGoogleConfig } from "@/lib/clientProcessingConfig";
import { GoogleSheetsService } from "@/services/googleSheets.service";
import { cuitDigits } from "@/lib/cuit";
import { planCuitEntity } from "@/lib/directorySyncPlan";

loadEnv();

async function main() {
  const prisma = getPrismaClient();
  const found = await prisma.client.findFirstOrThrow({
    where: { name: { contains: "Morinigo", mode: "insensitive" } },
    select: { id: true, googleConfigJson: true },
  });
  const client = await loadProcessingClient(found.id);
  const googleConfig = resolveGoogleConfig(client!);
  const altaSheetsId = (found.googleConfigJson as Record<string, string>).altaSheetsId;
  const dir = await new GoogleSheetsService({ ...googleConfig!, sheetsId: altaSheetsId }).readDirectory();

  for (const [label, rows] of [["PROVEEDORES", dir.providers], ["CONSORCIOS", dir.consortiums]] as const) {
    const byName = new Map<string, number>();
    const byCuit = new Map<string, string[]>();
    for (const r of rows) {
      byName.set(r.canonicalName, (byName.get(r.canonicalName) ?? 0) + 1);
      const d = cuitDigits(r.cuit);
      if (d) byCuit.set(d, [...(byCuit.get(d) ?? []), r.canonicalName]);
    }
    const dupN = [...byName.entries()].filter(([, n]) => n > 1);
    const dupC = [...byCuit.entries()].filter(([, n]) => n.length > 1);
    console.log(`${label}: ${rows.length} filas · razón social repetida: ${dupN.length} · CUIT repetido: ${dupC.length}`);
    for (const [n, c] of dupN) console.log(`   repetida: "${n}" x${c}`);
    for (const [c, n] of dupC) console.log(`   CUIT ${c} → ${n.join(" || ")}`);
  }

  // Qué haría el sync ahora mismo con los proveedores.
  const existing = await prisma.provider.findMany({
    where: { clientId: found.id },
    select: { id: true, canonicalName: true, cuit: true, matchNames: true, paymentAlias: true },
  });
  const plan = planCuitEntity({
    sheetRows: dir.providers.map((p) => ({
      canonicalName: p.canonicalName, cuit: p.cuit, matchNames: p.matchNames, paymentAlias: p.paymentAlias,
    })),
    existing,
    compareFields: ["cuit", "matchNames", "paymentAlias"],
  });
  console.log(`\nPlan del sync (proveedores): altas=${plan.creates.length} · updates=${plan.updates.length} · repetidos=${plan.duplicates.length} · sobrantes=${plan.orphans.length}`);
  for (const c of plan.creates) console.log(`   ALTA: ${c.canonicalName} [${c.cuit}]`);
  for (const d of plan.duplicates) console.log(`   REPETIDO: ${d.kind} ${d.value}`);
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e.message ?? e); process.exit(1); });
