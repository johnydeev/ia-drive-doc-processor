import { z } from "zod";
import { apiOk, withAuth, withClientAuth } from "@/lib/apiHandler";
import { getPrismaClient } from "@/lib/prisma";

const createSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(255).optional(),
  order: z.number().int().min(1).max(99).optional(),
});

export const GET = withAuth(async ({ session }) => {
  const prisma = getPrismaClient();
  // Los numerados primero, en su número; los sin número al final, alfabéticos.
  // Es el orden con el que se dibujan las secciones de la liquidación.
  const rubros = await prisma.rubro.findMany({
    where: { clientId: session.clientId },
    orderBy: [{ order: { sort: "asc", nulls: "last" } }, { name: "asc" }],
  });
  return apiOk({ rubros });
});

export const POST = withClientAuth(async ({ request, session }) => {
  const prisma = getPrismaClient();
  const body = createSchema.parse(await request.json());

  const rubro = await prisma.rubro.create({
    data: {
      clientId: session.clientId,
      name: body.name.trim().toUpperCase(),
      description: body.description?.trim() ?? null,
      order: body.order ?? null,
    },
  });

  return apiOk({ rubro }, 201);
});
