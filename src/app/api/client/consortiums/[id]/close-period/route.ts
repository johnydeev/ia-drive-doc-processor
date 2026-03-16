import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuthenticatedSession } from "@/lib/adminAuth";
import { ConsortiumRepository } from "@/repositories/consortium.repository";
import { getPrismaClient } from "@/lib/prisma";

const bodySchema = z.object({
  confirmed: z.boolean().optional(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = requireAuthenticatedSession(request);
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

  const { id: consortiumId } = await context.params;

  try {
    const prisma = getPrismaClient();
    const consortium = await prisma.consortium.findFirst({
      where: { id: consortiumId, clientId: auth.session.clientId },
      select: { id: true },
    });

    if (!consortium) {
      return NextResponse.json(
        { ok: false, error: "Consortium not found" },
        { status: 404 }
      );
    }

    const body = bodySchema.parse(await request.json());
    const repo = new ConsortiumRepository();

    if (body.confirmed !== true) {
      const currentPeriod = await repo.findActivePeriod(consortiumId);
      if (!currentPeriod) {
        return NextResponse.json(
          { ok: false, error: "No active period found for consortium" },
          { status: 400 }
        );
      }

      return NextResponse.json({
        ok: true,
        requiresConfirmation: true,
        message: "¿Confirmás el cierre del período actual?",
        currentPeriod: {
          year: currentPeriod.year,
          month: currentPeriod.month,
        },
      });
    }

    const closedPeriod = await repo.findActivePeriod(consortiumId);
    if (!closedPeriod) {
      return NextResponse.json(
        { ok: false, error: "No active period found for consortium" },
        { status: 400 }
      );
    }

    const newPeriod = await repo.closePeriodAndCreateNext(consortiumId);

    return NextResponse.json({
      ok: true,
      closedPeriod,
      newPeriod,
    });
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
