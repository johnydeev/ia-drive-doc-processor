import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { FixedExpenseRepository, FixedExpenseError } from "@/repositories/fixedExpense.repository";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;
  const { id: consortiumId } = await context.params;
  const clientId = auth.session.clientId;

  const repo = new FixedExpenseRepository();
  const items = await repo.listByConsortium(consortiumId, clientId);
  return NextResponse.json({ ok: true, fixedExpenses: items });
}

const createSchema = z.object({
  providerId: z.string().optional().nullable(),
  lspServiceId: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
});

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;
  const { id: consortiumId } = await context.params;
  const clientId = auth.session.clientId;

  try {
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.issues[0].message }, { status: 400 });
    }

    // El consorcio debe pertenecer al cliente.
    const prisma = getPrismaClient();
    const consortium = await prisma.consortium.findFirst({ where: { id: consortiumId, clientId } });
    if (!consortium) return NextResponse.json({ ok: false, error: "Consorcio no encontrado" }, { status: 404 });

    const repo = new FixedExpenseRepository();
    const created = await repo.create({
      clientId,
      consortiumId,
      providerId: parsed.data.providerId ?? null,
      lspServiceId: parsed.data.lspServiceId ?? null,
      description: parsed.data.description ?? null,
    });
    return NextResponse.json({ ok: true, fixedExpense: created }, { status: 201 });
  } catch (err) {
    if (err instanceof FixedExpenseError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Error interno" }, { status: 500 });
  }
}
