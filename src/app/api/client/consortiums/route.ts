import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuthenticatedSession } from "@/lib/adminAuth";
import { ConsortiumRepository } from "@/repositories/consortium.repository";
import { getPrismaClient } from "@/lib/prisma";
import { formatCuit } from "@/lib/cuit";
import { isDuplicateCuit } from "@/lib/duplicateCuit";

const bodySchema = z.object({
  canonicalName: z.string().min(2),
  cuit: z.string().optional(),
  cutoffDay: z.number().int().min(1).max(31).optional(),
  driveFolderProcessedId: z.string().optional(),
});

export async function GET(request: Request) {
  const auth = await requireAuthenticatedSession(request);
  if (auth.error) {
    return auth.error;
  }

  try {
    const repo = new ConsortiumRepository();
    const consortiums = await repo.listByClient(auth.session.clientId);
    return NextResponse.json({ ok: true, consortiums });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const auth = await requireAuthenticatedSession(request);
  if (auth.error) {
    return auth.error;
  }

  if (auth.session.role !== "CLIENT") {
    return NextResponse.json(
      {
        ok: false,
        error: "Forbidden",
      },
      { status: 403 }
    );
  }

  try {
    const body = bodySchema.parse(await request.json());

    // El CUIT identifica al edificio: la razón social cambia, el CUIT no. Se
    // guarda canónico (XX-XXXXXXXX-X) y el duplicado se busca POR DÍGITOS, para
    // que "30711111111" y "30-71111111-1" cuenten como el mismo — si se comparara
    // el texto, el unique de la base tampoco los vería y el duplicado entraría.
    // Mismo criterio que el alta de proveedores.
    const cuitCanonical = body.cuit ? (formatCuit(body.cuit) ?? body.cuit.trim()) : undefined;

    if (cuitCanonical) {
      const prisma = getPrismaClient();
      const existing = await prisma.consortium.findMany({
        where: { clientId: auth.session.clientId, cuit: { not: null } },
        select: { cuit: true },
      });
      if (isDuplicateCuit(existing, cuitCanonical)) {
        return NextResponse.json(
          { ok: false, error: "Ya existe un edificio con ese CUIT para este cliente" },
          { status: 409 }
        );
      }
    }

    const repo = new ConsortiumRepository();
    const consortium = await repo.createManual({
      clientId: auth.session.clientId,
      canonicalName: body.canonicalName,
      rawName: body.canonicalName,
      cuit: cuitCanonical,
      cutoffDay: body.cutoffDay,
      driveFolderProcessedId: body.driveFolderProcessedId,
    });

    return NextResponse.json({ ok: true, consortium });
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join(", ")
        : error instanceof Error
          ? error.message
          : "Unknown error";

    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
