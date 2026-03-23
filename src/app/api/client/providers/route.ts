import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuthenticatedSession } from "@/lib/adminAuth";
import { getPrismaClient } from "@/lib/prisma";

const createSchema = z.object({
  canonicalName: z.string().min(2),
  cuit: z.string().min(11).max(13),
  paymentAlias: z.string().optional(),
});

export async function GET(request: Request) {
  const auth = requireAuthenticatedSession(request);
  if (auth.error) return auth.error;

  try {
    const prisma = getPrismaClient();
    const providers = await prisma.provider.findMany({
      where: { clientId: auth.session.clientId },
      orderBy: { canonicalName: "asc" },
    });
    return NextResponse.json({ ok: true, providers });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const auth = requireAuthenticatedSession(request);
  if (auth.error) return auth.error;

  if (auth.session.role !== "CLIENT" && auth.session.role !== "ADMIN") {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = createSchema.parse(await request.json());
    const prisma = getPrismaClient();

    // Normalizar CUIT: quitar guiones para comparación
    const cuitNorm = body.cuit.replace(/-/g, "").trim();

    const existing = await prisma.provider.findFirst({
      where: { clientId: auth.session.clientId, cuit: { in: [body.cuit, cuitNorm] } },
    });
    if (existing) {
      return NextResponse.json(
        { ok: false, error: "Ya existe un proveedor con ese CUIT para este cliente" },
        { status: 409 }
      );
    }

    const provider = await prisma.provider.create({
      data: {
        clientId: auth.session.clientId,
        canonicalName: body.canonicalName.trim(),
        cuit: body.cuit.trim(),
        paymentAlias: body.paymentAlias?.trim() || null,
      },
    });

    // Matching: buscar facturas sin proveedor asignado con ese CUIT
    // y moverlas de vuelta a PENDING en processingJob para que el worker
    // las revalide en el siguiente ciclo.
    const unassignedInvoices = await prisma.invoice.findMany({
      where: {
        clientId: auth.session.clientId,
        providerId: null,
        providerTaxId: { in: [body.cuit, cuitNorm] },
      },
      select: { id: true, driveFileId: true },
    });

    if (unassignedInvoices.length > 0) {
      // Crear jobs pendientes para los archivos que tengan driveFileId
      const filesToRequeue = unassignedInvoices.filter((inv) => inv.driveFileId);

      for (const inv of filesToRequeue) {
        // Solo encolar si no hay ya un job pendiente/processing para ese archivo
        const existing = await prisma.processingJob.findFirst({
          where: {
            clientId: auth.session.clientId,
            driveFileId: inv.driveFileId!,
            status: { in: ["PENDING", "PROCESSING"] },
          },
          select: { id: true },
        });

        if (!existing) {
          await prisma.processingJob.create({
            data: {
              clientId: auth.session.clientId,
              driveFileId: inv.driveFileId!,
              driveFileName: null,
              status: "PENDING",
            },
          });
        }
      }

      // Limpiar las facturas sin asignar para que el worker las procese fresco
      await prisma.invoice.deleteMany({
        where: {
          clientId: auth.session.clientId,
          providerId: null,
          providerTaxId: { in: [body.cuit, cuitNorm] },
          driveFileId: { not: null },
        },
      });
    }

    return NextResponse.json({
      ok: true,
      provider,
      requeued: unassignedInvoices.filter((i) => i.driveFileId).length,
    });
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues.map((i) => i.message).join(", ")
        : error instanceof Error
          ? error.message
          : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
