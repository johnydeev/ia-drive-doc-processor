import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClientSession } from "@/lib/clientAuth";
import { apiError, apiOk } from "@/lib/apiHandler";
import { BankRepository } from "@/repositories/bank.repository";
import { BANK_COLOR_SLUGS } from "@/app/admin/consortiums/lib/bankPalette";

const updateSchema = z.object({
  name: z.string().min(1, "El nombre es obligatorio").max(60).optional(),
  color: z.string().refine((c) => BANK_COLOR_SLUGS.includes(c), "Color inválido").optional(),
});

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;

  const { id } = await context.params;

  try {
    const repo = new BankRepository();
    const bank = await repo.findById(auth.session.clientId, id);
    if (!bank) {
      return NextResponse.json({ ok: false, error: "Banco no encontrado" }, { status: 404 });
    }

    const body = updateSchema.parse(await request.json());
    const name = body.name?.trim();

    if (name) {
      const banks = await repo.listByClient(auth.session.clientId);
      if (banks.some((b) => b.id !== id && b.name.toLowerCase() === name.toLowerCase())) {
        return apiError(new Error("Ya existe un banco con ese nombre"), 409);
      }
    }

    const updated = await repo.update(id, {
      ...(name !== undefined && { name }),
      ...(body.color !== undefined && { color: body.color }),
    });
    return apiOk({ bank: updated });
  } catch (error) {
    return apiError(error, 400);
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;

  const { id } = await context.params;

  try {
    const repo = new BankRepository();
    const bank = await repo.findById(auth.session.clientId, id);
    if (!bank) {
      return NextResponse.json({ ok: false, error: "Banco no encontrado" }, { status: 404 });
    }

    // Los consorcios asignados quedan con bankId = null por el ON DELETE SET NULL.
    await repo.remove(id);
    return apiOk();
  } catch (error) {
    return apiError(error);
  }
}
