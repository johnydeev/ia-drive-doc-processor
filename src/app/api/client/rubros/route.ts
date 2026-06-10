import { z } from "zod";
import { apiOk, withAuth, withClientAuth } from "@/lib/apiHandler";
import { getPrismaClient } from "@/lib/prisma";

const createSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(255).optional(),
});

export const GET = withAuth(async ({ session }) => {
  const prisma = getPrismaClient();
  const rubros = await prisma.rubro.findMany({
    where: { clientId: session.clientId },
    orderBy: { name: "asc" },
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
    },
  });

  return apiOk({ rubro }, 201);
});
