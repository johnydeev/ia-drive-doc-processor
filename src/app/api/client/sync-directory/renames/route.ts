import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { applyRenames } from "@/services/directorySync.service";

const schema = z.object({
  renames: z
    .array(
      z.object({
        entity: z.enum(["consortium", "provider"]),
        id: z.string().min(1),
        to: z.string().min(1),
      })
    )
    .min(1),
});

/**
 * Aplica los renombres confirmados por el usuario en el modal del sync.
 *
 * Recibe la lista exacta que se mostró en pantalla: no re-deriva nada del archivo
 * ALTA. Por eso es idempotente y no puede tocar nada que el usuario no haya visto.
 */
export async function POST(request: NextRequest) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues[0].message }, { status: 400 });
  }

  const prisma = getPrismaClient();
  const result = await applyRenames(prisma, auth.session.clientId, parsed.data.renames);

  return NextResponse.json({ ok: true, ...result });
}
