import { TokenUsageSummary } from "@/types/aiUsage.types";

export interface ProcessJobErrorEntry {
  fileId: string;
  fileName: string;
  error: string;
}

export interface ProcessJobSummary {
  clientId?: string;
  clientName?: string;
  totalFound: number;
  processed: number;
  skipped: number;
  failed: number;
  unassigned: number;
  duplicatesDetected: number;
  /**
   * Boletas diferidas por cuota de IA agotada (429 en todos los proveedores).
   * Señal para el circuit breaker: el worker pausa el encolado del cliente
   * (SchedulerState.aiPausedUntil) hasta el próximo reset de cuota.
   */
  rateLimited?: number;
  /** Documentos clasificados como no-boleta (triage) y derivados a Revisión. */
  notBoleta?: number;
  errors: ProcessJobErrorEntry[];
  tokenUsage: TokenUsageSummary;
  clientSummaries?: ProcessJobSummary[];
}
