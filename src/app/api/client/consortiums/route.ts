import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuthenticatedSession } from "@/lib/adminAuth";
import { ConsortiumRepository } from "@/repositories/consortium.repository";

const bodySchema = z.object({
  canonicalName: z.string().min(2),
  cuit: z.string().optional(),
  cutoffDay: z.number().int().min(1).max(31).optional(),
  driveFolderProcessedId: z.string().optional(),
});

export async function GET(request: Request) {
  const auth = requireAuthenticatedSession(request);
  if (auth.error) {
    return auth.error;
  }

  try {
    const repo = new ConsortiumRepository();
    const consortiums = await repo.listByClient(auth.session.clientId);
    return NextResponse.json({ ok: true, consortiums });
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

export async function POST(request: Request) {
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

  try {
    const body = bodySchema.parse(await request.json());
    const repo = new ConsortiumRepository();
    const consortium = await repo.createManual({
      clientId: auth.session.clientId,
      canonicalName: body.canonicalName,
      rawName: body.canonicalName,
      cuit: body.cuit,
      cutoffDay: body.cutoffDay,
      driveFolderProcessedId: body.driveFolderProcessedId,
    });

    return NextResponse.json({ ok: true, consortium });
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
