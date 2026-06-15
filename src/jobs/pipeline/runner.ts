import { RateLimitError } from "@/lib/aiErrors";
import { pipelineLog } from "@/lib/logger";
import type { PipelineContext, PipelineStep } from "./context";

/**
 * Ejecuta una cadena de pasos sobre el `PipelineContext`. Corta al primer paso
 * que devuelve `halt` (registrando su `result`/`reason` en `m`). Centraliza:
 *  - **Errores**: `RateLimitError` → la boleta vuelve a Pendientes (no se marca
 *    fallida); cualquier otro error → Revisión + `summary.failed`.
 *  - **Métricas**: una única línea `[metrics]` por boleta en el `finally`, en
 *    TODOS los caminos de salida (ok / duplicate / unassigned / no_amount /
 *    no_period / rate_limited / failed).
 *
 * Esta es la misma orquestación que antes vivía dentro de `processDriveFile`;
 * sacarla acá permite que cada paso sea una función discreta y testeable.
 */
export async function runPipeline(steps: PipelineStep[], ctx: PipelineContext): Promise<void> {
  const { file, summary, deps, m } = ctx;
  const { resolvedConfig, driveService } = deps;
  const cid = resolvedConfig.clientId;

  try {
    for (const step of steps) {
      const result = await step(ctx);
      if (result.kind === "halt") {
        m.result = result.result;
        m.reason = result.reason;
        break;
      }
    }
  } catch (error) {
    // ── Rate-limit de IA (429): caso aparte ────────────────────────────────
    // NO se pierde la boleta ni se marca como fallida. Se devuelve a Pendientes
    // (si hubo lock en Procesando) y el job se completa OK; el scheduler la
    // re-encola en un ciclo posterior, cuando la cuota se haya recuperado. Así
    // se evita el loop de reintentos inmediatos que quemaba cuota.
    if (error instanceof RateLimitError) {
      m.result = "rate_limited";
      m.reason = "rate_limit";
      m.reasonText = error.message;
      summary.skipped += 1;
      summary.rateLimited = (summary.rateLimited ?? 0) + 1;
      pipelineLog.stepStart(cid, `⏸️  Rate-limit IA → boleta devuelta a Pendientes para reintento posterior`);
      if (resolvedConfig.driveProcessingFolderId && resolvedConfig.drivePendingFolderId) {
        try {
          await driveService.moveFileToFolder(
            file.id,
            resolvedConfig.driveProcessingFolderId,
            resolvedConfig.drivePendingFolderId
          );
        } catch {
          // best-effort: si no se puede devolver, el scheduler igual la reintentará
        }
      }
      return;
    }

    summary.failed += 1;
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    summary.errors.push({ fileId: file.id, fileName: file.name, error: errorMessage });
    m.result = "failed";
    m.reason = "error";
    m.reasonText = errorMessage;
    pipelineLog.fileFailed(cid, file.name, errorMessage);
    // Para el catch, intentamos usar Procesando primero (si existe) y caer a Pendientes.
    const failSourceFolderId =
      resolvedConfig.driveProcessingFolderId ?? resolvedConfig.drivePendingFolderId;
    if (resolvedConfig.driveFailedFolderId && failSourceFolderId) {
      try {
        await driveService.moveFileToFailed(file.id, failSourceFolderId, resolvedConfig.driveFailedFolderId);
        pipelineLog.movedToFailed(cid, file.id);
      } catch {
        // Silent — ya logueamos el error principal
      }
    }
  } finally {
    // Una sola línea [metrics] por boleta, en TODOS los caminos de salida
    // (ok / unassigned / duplicate / no_period / failed). `values` solo con debug.
    m.ms.total = Date.now() - ctx.startedAt;
    pipelineLog.metrics(
      {
        ts: new Date().toISOString(),
        client: cid,
        file: file.name,
        fileId: file.id,
        mime: file.mimeType ?? null,
        textSource: m.textSource,
        textChars: m.textChars,
        emitterBlock: m.emitterBlock,
        lsp: m.lsp,
        ai: m.ai,
        ms: m.ms,
        match: m.match,
        result: m.result,
        reason: m.reason,
      },
      { extracted: m.extracted, canonical: m.canonical, reasonText: m.reasonText },
      !!resolvedConfig.debugMode
    );
  }
}
