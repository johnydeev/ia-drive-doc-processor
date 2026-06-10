import { z } from "zod";
import { apiOk, withAuth, withClientAuth } from "@/lib/apiHandler";
import { getPrismaClient } from "@/lib/prisma";

const createSchema = z.object({
  code: z.string().min(1).max(10),
  name: z.string().min(1).max(100),
  value: z.number().positive().optional(),
});

export const GET = withAuth(async ({ session }) => {
  const prisma = getPrismaClient();
  const coeficientes = await prisma.coeficiente.findMany({
    where: { clientId: session.clientId },
    orderBy: { code: "asc" },
  });
  return apiOk({ coeficientes });
});

export const POST = withClientAuth(async ({ request, session }) => {
  const prisma = getPrismaClient();
  const body = createSchema.parse(await request.json());

  const coeficiente = await prisma.coeficiente.create({
    data: {
      clientId: session.clientId,
      code: body.code.trim().toUpperCase(),
      name: body.name.trim().toUpperCase(),
      value: body.value ?? null,
    },
  });

  return apiOk({ coeficiente }, 201);
});
