import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedSession } from "@/lib/adminAuth";
import { getPrismaClient } from "@/lib/prisma";
import { GoogleSheetsService } from "@/services/googleSheets.service";
import { resolveGoogleConfig } from "@/lib/clientProcessingConfig";

export async function POST(request: NextRequest) {
  const auth = requireAuthenticatedSession(request);
  if (auth.error) return auth.error;

  const clientId = auth.session.clientId;

  try {
    const prisma = getPrismaClient();

    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client) {
      return NextResponse.json({ ok: false, error: "Cliente no encontrado" }, { status: 404 });
    }

    const rawConfig = client.googleConfigJson as Record<string, unknown> | null;
    const altaSheetsId = rawConfig?.altaSheetsId as string | undefined;

    if (!altaSheetsId) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Configurá el ID del archivo ALTA de Google Sheets antes de sincronizar. " +
            "Creá un archivo llamado 'ALTA' compartido con la cuenta de servicio y pegá su ID en la configuración.",
        },
        { status: 400 }
      );
    }

    // resolveGoogleConfig desencripta la private key correctamente
    const googleConfig = resolveGoogleConfig(client as any);
    if (!googleConfig) {
      return NextResponse.json(
        { ok: false, error: "Credenciales de Google incompletas" },
        { status: 400 }
      );
    }

    // Usar las mismas credenciales pero apuntando al archivo ALTA
    const altaService = new GoogleSheetsService({ ...googleConfig, sheetsId: altaSheetsId });

    const directory = await altaService.readDirectory();

    const warnings: string[] = [...directory.warnings];

    const syncedAt = new Date();

    // Sincronizar en DB: upsert lo que está en Sheets, eliminar lo que no está
    await prisma.$transaction(async (tx) => {
      // --- Rubros (reemplazo total: sin FK que afecte invoices) ---
      await tx.rubro.deleteMany({ where: { clientId } });
      if (directory.rubros.length > 0) {
        await tx.rubro.createMany({
          data: directory.rubros.map((r) => ({
            clientId,
            name: r.name,
            description: r.description,
          })),
        });
      }

      // --- Coeficientes (reemplazo total) ---
      await tx.coeficiente.deleteMany({ where: { clientId } });
      if (directory.coeficientes.length > 0) {
        await tx.coeficiente.createMany({
          data: directory.coeficientes.map((c) => ({
            clientId,
            code: c.code,
            name: c.name,
          })),
        });
      }

      // --- Consorcios (upsert + eliminar huérfanos) ---
      for (const c of directory.consortiums) {
        await tx.consortium.upsert({
          where: { clientId_canonicalName: { clientId, canonicalName: c.canonicalName } },
          update: { cuit: c.cuit, aliases: c.aliases },
          create: {
            clientId,
            canonicalName: c.canonicalName,
            rawName: c.canonicalName,
            cuit: c.cuit,
            aliases: c.aliases,
          },
        });
      }

      const sheetsConsortiumNames = new Set(directory.consortiums.map((c) => c.canonicalName));
      const dbConsortiums = await tx.consortium.findMany({
        where: { clientId },
        select: { id: true, canonicalName: true },
      });
      const orphanConsortiumIds = dbConsortiums
        .filter((c) => !sheetsConsortiumNames.has(c.canonicalName))
        .map((c) => c.id);

      if (orphanConsortiumIds.length > 0) {
        try {
          await tx.consortium.deleteMany({ where: { id: { in: orphanConsortiumIds } } });
        } catch {
          warnings.push(
            `${orphanConsortiumIds.length} consorcio(s) no pudieron eliminarse porque tienen boletas asociadas. Eliminalos manualmente desde el panel.`
          );
        }
      }

      // --- Proveedores (upsert + eliminar huérfanos) ---
      for (const p of directory.providers) {
        const existing = await tx.provider.findFirst({
          where: { clientId, canonicalName: p.canonicalName },
        });
        if (existing) {
          await tx.provider.update({
            where: { id: existing.id },
            data: { cuit: p.cuit, alias: p.alias },
          });
        } else {
          await tx.provider.create({
            data: { clientId, canonicalName: p.canonicalName, cuit: p.cuit, alias: p.alias },
          });
        }
      }

      const sheetsProviderNames = new Set(directory.providers.map((p) => p.canonicalName));
      const dbProviders = await tx.provider.findMany({
        where: { clientId },
        select: { id: true, canonicalName: true },
      });
      const orphanProviderIds = dbProviders
        .filter((p) => !sheetsProviderNames.has(p.canonicalName))
        .map((p) => p.id);

      if (orphanProviderIds.length > 0) {
        try {
          await tx.provider.deleteMany({ where: { id: { in: orphanProviderIds } } });
        } catch {
          warnings.push(
            `${orphanProviderIds.length} proveedor(es) no pudieron eliminarse porque tienen boletas asociadas. Eliminalos manualmente desde el panel.`
          );
        }
      }
    });

    // Guardar fecha de última sincronización
    await prisma.schedulerState.upsert({
      where: { clientId },
      update: { lastDirectorySyncAt: syncedAt },
      create: { clientId, lastDirectorySyncAt: syncedAt },
    });

    return NextResponse.json({
      ok: true,
      consortiumsCount: directory.consortiums.length,
      providersCount: directory.providers.length,
      rubrosCount: directory.rubros.length,
      coeficientesCount: directory.coeficientes.length,
      syncedAt,
      ...(warnings.length > 0 && { warnings }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error al sincronizar";

    if (message.includes("403") || message.includes("PERMISSION_DENIED")) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Sin permisos de lectura en el archivo ALTA. Compartilo con la cuenta de servicio de Google.",
        },
        { status: 403 }
      );
    }

    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
