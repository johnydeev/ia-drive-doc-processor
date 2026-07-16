import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/config/env";
import { setAuthCookie } from "@/lib/authSession";
import { verifyPassword } from "@/lib/password";
import { getPrismaClient } from "@/lib/prisma";

const bodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(request: Request) {
  const secret = env.SESSION_SECRET?.trim();
  if (!secret) {
    return NextResponse.json(
      {
        ok: false,
        error: "SESSION_SECRET is not configured",
      },
      { status: 500 }
    );
  }

  try {
    const body = bodySchema.parse(await request.json());
    const prisma = getPrismaClient();

    const user = await prisma.client.findUnique({
      where: { email: body.email.toLowerCase() },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        name: true,
        role: true,
        isActive: true,
      },
    });

    if (!user) {
      return NextResponse.json({ ok: false, error: "Invalid credentials" }, { status: 401 });
    }

    if (!user.isActive) {
      // Misma respuesta que credenciales inválidas: no confirmar que el email existe.
      console.warn(`[login] intento de login de cuenta inactiva: ${user.id}`);
      return NextResponse.json({ ok: false, error: "Invalid credentials" }, { status: 401 });
    }

    const valid = await verifyPassword(body.password, user.passwordHash);
    if (!valid) {
      return NextResponse.json({ ok: false, error: "Invalid credentials" }, { status: 401 });
    }

    const response = NextResponse.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    });

    setAuthCookie(
      response,
      {
        clientId: user.id,
        email: user.email,
        role: user.role,
      },
      secret
    );

    return response;
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { ok: false, error: error.issues.map((issue) => issue.message).join(", ") },
        { status: 400 }
      );
    }

    // Error inesperado (DB caída, etc.): no filtrar el mensaje interno al cliente.
    console.error("[login] error interno:", error);
    const message =
      process.env.NODE_ENV === "production"
        ? "Error interno"
        : error instanceof Error
          ? error.message
          : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
