import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { checkAssignable } from "@/lib/rubroAssignment";
import { FixedExpenseRepository, FixedExpenseError } from "@/repositories/fixedExpense.repository";

/**
 * `rubroId` y `coeficienteId` fijan la regla hacia adelante (spec 2026-09-24): las
 * boletas que entren después la heredan al vincularse a su obligación. La boleta del
 * mes en curso la corrige el llamador — la hoja manda las dos cosas.
 */
const patchSchema = z.object({
  active: z.boolean().optional(),
  description: z.string().optional().nullable(),
  rubroId: z.string().nullable().optional(),
  coeficienteId: z.string().nullable().optional(),
});

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string; fxId: string }> }) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;
  const { fxId } = await context.params;
  const clientId = auth.session.clientId;

  try {
    const parsed = patchSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.issues[0].message }, { status: 400 });
    }
    // Capa 3: sólo se acepta un rubro o coeficiente que el edificio tenga asignado
    // (capa 2). La decisión vive en `checkAssignable`, que se testea sin base.
    if (parsed.data.rubroId !== undefined || parsed.data.coeficienteId !== undefined) {
      const prisma = getPrismaClient();
      const fx = await prisma.fixedExpense.findFirst({
        where: { id: fxId, clientId },
        select: { consortiumId: true },
      });
      if (!fx) {
        return NextResponse.json({ ok: false, error: "Gasto fijo no encontrado" }, { status: 404 });
      }

      if (parsed.data.rubroId !== undefined) {
        const asignados = await prisma.consortiumRubro.findMany({
          where: { consortiumId: fx.consortiumId },
          select: { rubroId: true },
        });
        const check = checkAssignable(parsed.data.rubroId, asignados.map((a) => a.rubroId), "rubro");
        if (!check.ok) return NextResponse.json({ ok: false, error: check.error }, { status: 400 });
      }

      if (parsed.data.coeficienteId !== undefined) {
        const asignados = await prisma.consortiumCoeficiente.findMany({
          where: { consortiumId: fx.consortiumId },
          select: { coeficienteId: true },
        });
        const check = checkAssignable(
          parsed.data.coeficienteId,
          asignados.map((a) => a.coeficienteId),
          "coeficiente"
        );
        if (!check.ok) return NextResponse.json({ ok: false, error: check.error }, { status: 400 });
      }
    }

    const repo = new FixedExpenseRepository();
    const updated = await repo.update(fxId, clientId, parsed.data);
    return NextResponse.json({ ok: true, fixedExpense: updated });
  } catch (err) {
    if (err instanceof FixedExpenseError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Error interno" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string; fxId: string }> }) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;
  const { fxId } = await context.params;
  const clientId = auth.session.clientId;

  try {
    const repo = new FixedExpenseRepository();
    await repo.delete(fxId, clientId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof FixedExpenseError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Error interno" }, { status: 500 });
  }
}
