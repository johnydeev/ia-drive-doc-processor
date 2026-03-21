/**
 * Script para crear un usuario ADMIN desde la línea de comandos.
 *
 * Uso:
 *   npx tsx scripts/create-admin.ts <email> <password>
 *
 * Ejemplo:
 *   npx tsx scripts/create-admin.ts admin@miempresa.com MiPassword123
 */

import { loadEnv } from "../src/lib/loadEnv";
loadEnv();

import { hashPassword } from "../src/lib/password";
import { getPrismaClient } from "../src/lib/prisma";

async function main() {
  const [, , email, password] = process.argv;

  if (!email || !password) {
    console.error("Uso: npx tsx scripts/create-admin.ts <email> <password>");
    process.exit(1);
  }

  if (password.length < 8) {
    console.error("La contraseña debe tener al menos 8 caracteres.");
    process.exit(1);
  }

  const prisma = getPrismaClient();

  const existing = await prisma.client.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, role: true },
  });

  if (existing) {
    console.error(`Ya existe un usuario con ese email (rol: ${existing.role}).`);
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);

  const admin = await prisma.client.create({
    data: {
      name: "Admin",
      email: email.toLowerCase(),
      passwordHash,
      role: "ADMIN",
      isActive: true,
    },
    select: { id: true, email: true, role: true },
  });

  console.log("✓ Usuario ADMIN creado:");
  console.log(`  ID:    ${admin.id}`);
  console.log(`  Email: ${admin.email}`);
  console.log(`  Rol:   ${admin.role}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
