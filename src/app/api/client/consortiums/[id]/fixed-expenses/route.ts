import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { FixedExpenseRepository, FixedExpenseError } from "@/repositories/fixedExpense.repository";
import { generateObligationsForPeriod } from "@/services/obligation.service";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;
  const { id: consortiumId } = await context.params;
  const clientId = auth.session.clientId;

  const repo = new FixedExpenseRepository();
  const items = await repo.listByConsortium(consortiumId, clientId);
  return NextResponse.json({ ok: true, fixedExpenses: items });
}

const itemSchema = z.object({
  providerId: z.string().optional().nullable(),
  lspServiceId: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
});

/** Acepta la forma vieja (un objeto) y la nueva (`{ items: [...] }`). */
const createSchema = z.union([
  z.object({ items: z.array(itemSchema).min(1).max(50) }),
  itemSchema,
]);

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

    // El `in` narrowing tiene que ser inline: a través de una variable booleana
    // TypeScript no lo propaga y `parsed.data.items` queda sin tipar.
    const bulk = "items" in parsed.data ? parsed.data : null;
    const items = bulk ? bulk.items : [parsed.data as z.infer<typeof itemSchema>];

    const repo = new FixedExpenseRepository();
    const created: unknown[] = [];
    const skipped: Array<{ providerId: string | null; lspServiceId: string | null; reason: string }> = [];

    for (const item of items) {
      try {
        created.push(
          await repo.create({
            clientId,
            consortiumId,
            providerId: item.providerId ?? null,
            lspServiceId: item.lspServiceId ?? null,
            description: item.description ?? null,
          })
        );
      } catch (err) {
        // Un objetivo ya cargado (409) no aborta el resto de la selección.
        if (err instanceof FixedExpenseError) {
          skipped.push({
            providerId: item.providerId ?? null,
            lspServiceId: item.lspServiceId ?? null,
            reason: err.message,
          });
          continue;
        }
        throw err;
      }
    }

    // Que las filas nuevas aparezcan en el período abierto sin esperar otra sincronización.
    if (created.length > 0) {
      const activePeriod = await prisma.period.findFirst({
        where: { consortiumId, status: "ACTIVE" },
        select: { id: true },
      });
      if (activePeriod) await generateObligationsForPeriod(activePeriod.id);
    }

    // Forma vieja (un solo objeto): se conserva la respuesta de siempre.
    if (!bulk) {
      if (skipped.length > 0) {
        return NextResponse.json({ ok: false, error: skipped[0].reason }, { status: 409 });
      }
      return NextResponse.json({ ok: true, fixedExpense: created[0] }, { status: 201 });
    }

    return NextResponse.json({ ok: true, created: created.length, skipped }, { status: 201 });
  } catch (err) {
    if (err instanceof FixedExpenseError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Error interno" }, { status: 500 });
  }
}
