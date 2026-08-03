import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedSession } from "@/lib/adminAuth";
import { requireClientSession } from "@/lib/clientAuth";
import { ConsortiumRepository } from "@/repositories/consortium.repository";
import { InvoiceRepository } from "@/repositories/invoice.repository";
import { getPrismaClient } from "@/lib/prisma";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuthenticatedSession(request);
  if (auth.error) {
    return auth.error;
  }

  const { id: consortiumId } = await context.params;

  try {
    const prisma = getPrismaClient();
    const consortium = await prisma.consortium.findFirst({
      where: { id: consortiumId, clientId: auth.session.clientId },
      include: { periods: true },
    });

    if (!consortium) {
      return NextResponse.json(
        { ok: false, error: "Consortium not found" },
        { status: 404 }
      );
    }

    const consortiumRepo = new ConsortiumRepository();
    const activePeriod = await consortiumRepo.findActivePeriod(consortium.id);

    const invoiceRepo = new InvoiceRepository();
    const invoices = activePeriod ? await invoiceRepo.findByPeriod(activePeriod.id) : [];

    return NextResponse.json({
      ok: true,
      consortium,
      activePeriod,
      invoices,
    });
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

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireClientSession(request);
  if (auth.error) {
    return auth.error;
  }

  const { id: consortiumId } = await context.params;

  try {
    const body = await request.json();
    const prisma = getPrismaClient();

    const consortium = await prisma.consortium.findFirst({
      where: { id: consortiumId, clientId: auth.session.clientId },
    });

    if (!consortium) {
      return NextResponse.json(
        { ok: false, error: "Consortium not found" },
        { status: 404 }
      );
    }

    const data: Record<string, unknown> = {};
    if (typeof body.matchNames === "string" || body.matchNames === null) {
      data.matchNames = body.matchNames || null;
    }

    // Banco asignado: null desasigna. Se valida que pertenezca al mismo cliente
    // para que un id de otro tenant no pueda enlazarse.
    if (typeof body.bankId === "string" || body.bankId === null) {
      if (body.bankId) {
        const bank = await prisma.bank.findFirst({
          where: { id: body.bankId, clientId: auth.session.clientId },
        });
        if (!bank) {
          return NextResponse.json({ ok: false, error: "Banco no encontrado" }, { status: 404 });
        }
        data.bankId = body.bankId;
      } else {
        data.bankId = null;
      }
    }

    // Datos de la cuenta del consorcio (bloque FORMA DE PAGO de la liquidación).
    const accountFields = ["bankAlias", "cbu", "accountNumber", "branch", "accountType", "accountHolder"] as const;
    for (const field of accountFields) {
      const value = body[field];
      if (typeof value === "string" || value === null) {
        data[field] = typeof value === "string" ? value.trim() || null : null;
      }
    }

    const updated = await prisma.consortium.update({
      where: { id: consortiumId },
      data,
      include: { bank: true },
    });

    return NextResponse.json({ ok: true, consortium: updated });
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
