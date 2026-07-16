import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClientSession } from "@/lib/clientAuth";
import { FixedExpenseRepository, FixedExpenseError } from "@/repositories/fixedExpense.repository";

const patchSchema = z.object({
  active: z.boolean().optional(),
  description: z.string().optional().nullable(),
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
