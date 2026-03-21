import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedSession } from "@/lib/adminAuth";
import { getPrismaClient } from "@/lib/prisma";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = requireAuthenticatedSession(request);
  if (auth.error) return auth.error;

  const { id: consortiumId } = await context.params;

  try {
    const prisma = getPrismaClient();

    const consortium = await prisma.consortium.findFirst({
      where: { id: consortiumId, clientId: auth.session.clientId },
      select: { id: true },
    });
    if (!consortium) {
      return NextResponse.json({ ok: false, error: "Consorcio no encontrado" }, { status: 404 });
    }

    const periods = await prisma.period.findMany({
      where: { consortiumId },
      orderBy: [{ year: "desc" }, { month: "desc" }],
    });

    return NextResponse.json({ ok: true, periods });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Error al obtener períodos" },
      { status: 500 }
    );
  }
}
