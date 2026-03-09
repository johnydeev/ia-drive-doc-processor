import { NextResponse } from "next/server";
import { requireAuthenticatedSession } from "@/lib/adminAuth";
import { runProcessingCycle } from "@/jobs/runProcessingCycle";

export async function POST(request: Request) {
  const auth = requireAuthenticatedSession(request);
  if (auth.error) {
    return auth.error;
  }

  if (auth.session.role !== "CLIENT") {
    return NextResponse.json(
      {
        ok: false,
        error: "Only CLIENT role can execute scheduler runs",
      },
      { status: 403 }
    );
  }

  try {
    const summary = await runProcessingCycle("manual", {
      ignoreEnabled: true,
      clientId: auth.session.clientId,
    });

    return NextResponse.json({
      ok: true,
      summary,
      scope: "single-client",
      clientId: auth.session.clientId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
