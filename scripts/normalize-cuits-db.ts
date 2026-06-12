/**
 * Normaliza los CUITs existentes en la DB al formato canónico XX-XXXXXXXX-X
 * (Provider.cuit y Consortium.cuit, todos los clientes).
 *
 * Por defecto es DRY-RUN (solo muestra qué cambiaría). Para aplicar:
 *   npx tsx scripts/normalize-cuits-db.ts --apply
 *
 * Solo toca filas cuyo CUIT tiene 11 dígitos y difiere del formato canónico.
 * Los valores sin 11 dígitos se listan como WARN (revisión manual) y no se tocan.
 */
import { getPrismaClient } from "@/lib/prisma";
import { cuitDigits, formatCuit } from "@/lib/cuit";

const APPLY = process.argv.includes("--apply");

async function main() {
  const prisma = getPrismaClient();
  let changed = 0;
  let warned = 0;

  for (const table of ["provider", "consortium"] as const) {
    const rows =
      table === "provider"
        ? await prisma.provider.findMany({ where: { cuit: { not: null } }, select: { id: true, canonicalName: true, cuit: true } })
        : await prisma.consortium.findMany({ where: { cuit: { not: null } }, select: { id: true, canonicalName: true, cuit: true } });

    for (const row of rows) {
      const canonical = formatCuit(row.cuit);
      if (!canonical) {
        if (cuitDigits(row.cuit).length > 0) {
          warned++;
          console.warn(`[WARN] ${table} "${row.canonicalName}": CUIT "${row.cuit}" no tiene 11 dígitos — revisar a mano`);
        }
        continue;
      }
      if (canonical === row.cuit) continue;

      changed++;
      console.log(`[${APPLY ? "FIX" : "DRY"}] ${table} "${row.canonicalName}": "${row.cuit}" → "${canonical}"`);
      if (APPLY) {
        if (table === "provider") {
          await prisma.provider.update({ where: { id: row.id }, data: { cuit: canonical } });
        } else {
          await prisma.consortium.update({ where: { id: row.id }, data: { cuit: canonical } });
        }
      }
    }
  }

  console.log(`\n${APPLY ? "Aplicados" : "Pendientes (dry-run)"}: ${changed} cambio(s). Warnings: ${warned}.`);
  if (!APPLY && changed > 0) console.log("Para aplicar: npx tsx scripts/normalize-cuits-db.ts --apply");
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
