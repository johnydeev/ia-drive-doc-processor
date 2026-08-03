import { z } from "zod";
import { apiError, apiOk, withAuth, withClientAuth } from "@/lib/apiHandler";
import { BankRepository } from "@/repositories/bank.repository";
import { BANK_COLOR_SLUGS, DEFAULT_BANK_COLOR } from "@/app/admin/consortiums/lib/bankPalette";

const createSchema = z.object({
  name: z.string().min(1, "El nombre es obligatorio").max(60),
  color: z.string().refine((c) => BANK_COLOR_SLUGS.includes(c), "Color inválido").optional(),
});

export const GET = withAuth(async ({ session }) => {
  const repo = new BankRepository();
  const banks = await repo.listByClient(session.clientId);
  return apiOk({ banks });
});

export const POST = withClientAuth(async ({ request, session }) => {
  const body = createSchema.parse(await request.json());
  const name = body.name.trim();
  const repo = new BankRepository();

  // El unique de Prisma es case-sensitive; acá se compara insensible para que
  // "Santander" y "santander" no convivan como dos bancos distintos.
  const banks = await repo.listByClient(session.clientId);
  if (banks.some((b) => b.name.toLowerCase() === name.toLowerCase())) {
    return apiError(new Error("Ya existe un banco con ese nombre"), 409);
  }

  const bank = await repo.create(session.clientId, name, body.color ?? DEFAULT_BANK_COLOR);
  return apiOk({ bank }, 201);
});
