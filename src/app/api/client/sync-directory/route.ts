import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { GoogleSheetsService } from "@/services/googleSheets.service";
import { resolveGoogleConfig } from "@/lib/clientProcessingConfig";
import type { ProcessingClient } from "@/types/client.types";
import { syncDirectory } from "@/services/directorySync.service";

/**
 * Sincroniza el directorio (edificios, proveedores, rubros, coeficientes y
 * servicios) desde el archivo ALTA de Google Sheets.
 *
 * La decisión de qué crear, actualizar o reportar vive en `directorySyncPlan.ts`
 * (puro) y la aplicación en `directorySync.service.ts`. Acá sólo queda la
 * autenticación, la configuración de Google y la respuesta.
 *
 * El sync NO borra: lo que está en la base y no en la hoja se informa en el
 * reporte. Los renombres detectados por CUIT quedan pendientes de confirmación
 * del usuario y se aplican desde `sync-directory/renames`.
 */
export async function POST(request: NextRequest) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;

  const clientId = auth.session.clientId;

  try {
    const startTime = Date.now();
    console.log(`[sync-directory] Iniciando sincronización — clientId=${clientId}`);

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

    // resolveGoogleConfig desencripta la private key. Nunca usar la del JSON crudo.
    // El cast salva la diferencia entre los JsonValue de Prisma y los tipos
    // estructurados de ProcessingClient; resolveGoogleConfig valida el contenido.
    const googleConfig = resolveGoogleConfig(client as unknown as ProcessingClient);
    if (!googleConfig) {
      return NextResponse.json({ ok: false, error: "Credenciales de Google incompletas" }, { status: 400 });
    }

    const altaService = new GoogleSheetsService({ ...googleConfig, sheetsId: altaSheetsId });
    const directory = await altaService.readDirectory();
    console.log(
      `[sync-directory] Directorio leído — consorcios=${directory.consortiums.length} proveedores=${directory.providers.length} rubros=${directory.rubros.length} coeficientes=${directory.coeficientes.length} lspServices=${directory.lspServices.length}`
    );

    const report = await syncDirectory(prisma, clientId, directory);

    const syncedAt = new Date();
    await prisma.schedulerState.upsert({
      where: { clientId },
      update: { lastDirectorySyncAt: syncedAt },
      create: { clientId, lastDirectorySyncAt: syncedAt },
    });

    console.log(`[sync-directory] ✅ Completado en ${Date.now() - startTime}ms`);
    if (report.warnings.length > 0) {
      console.warn(`[sync-directory] ⚠️ Warnings: ${report.warnings.join(" | ")}`);
    }

    return NextResponse.json({
      ok: true,
      report,
      syncedAt,
      consortiumsCount: directory.consortiums.length,
      providersCount: directory.providers.length,
      rubrosCount: directory.rubros.length,
      coeficientesCount: directory.coeficientes.length,
      lspServicesCount: directory.lspServices.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error al sincronizar";

    if (message.includes("403") || message.includes("PERMISSION_DENIED")) {
      return NextResponse.json(
        {
          ok: false,
          error: "Sin permisos de lectura en el archivo ALTA. Compartilo con la cuenta de servicio de Google.",
        },
        { status: 403 }
      );
    }

    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
