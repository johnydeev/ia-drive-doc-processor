import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";

const patchSchema = z.object({
  status: z.enum(["PENDING", "SKIPPED"]),
});

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const clientId = auth.session.clientId;

  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues[0].message }, { status: 400 });
  }

  const prisma = getPrismaClient();
  const ob = await prisma.expenseObligation.findFirst({ where: { id, clientId } });
  if (!ob) return NextResponse.json({ ok: false, error: "Obligación no encontrada" }, { status: 404 });

  // Solo se permite omitir/reactivar cuando NO está recibida (no pisar un vínculo real).
  if (ob.status === "RECEIVED") {
    return NextResponse.json({ ok: false, error: "La obligación ya tiene boleta recibida." }, { status: 409 });
  }

  const updated = await prisma.expenseObligation.update({ where: { id }, data: { status: parsed.data.status } });
  return NextResponse.json({ ok: true, obligation: updated });
}
