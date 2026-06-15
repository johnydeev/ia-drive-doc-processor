/**
 * Reintento acotado de operaciones de DB ante errores de conexión **transitorios**.
 *
 * Motivo: la DB (Supabase) se accede vía el pooler (PgBouncer), que cierra conexiones
 * idle y tiene eventos propios (reinicios) → Prisma lanza `P1017 "Server has closed the
 * connection"`. Un hipo así no debe dejar un job del worker a medias (zombie) ni disparar
 * reprocesos que gastan cuota de IA.
 *
 * Espeja el patrón ya probado de `callWithRetry` (lib/aiErrors.ts), que hace lo mismo para
 * los 429. A diferencia de aquél, al agotar los reintentos relanza el error ORIGINAL (no lo
 * envuelve), para que el caller lo maneje como hasta ahora.
 */

/**
 * Devuelve true SOLO si el error parece una caída de conexión transitoria (reintentar
 * tiene sentido). Deliberadamente acotado: NO se reutiliza `isPrismaConnectionError`
 * (lib/prisma.ts) porque ese matcher es amplio (incluye "database", "does not exist",
 * P2021/P2022 de schema) y reintentar errores de schema/negocio sería inútil.
 */
export function isTransientDbError(error: unknown): boolean {
  if (error === null || error === undefined) return false;

  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();

  return (
    text.includes("p1017") ||
    text.includes("p1001") ||
    text.includes("server has closed the connection") ||
    text.includes("connection closed") ||
    text.includes("connection terminated") ||
    text.includes("econnreset") ||
    text.includes("timed out fetching") || // pool timeout de Prisma
    text.includes("connection pool")
  );
}

export interface DbRetryOptions {
  /** Reintentos adicionales ante error transitorio (default 3). */
  retries?: number;
  /** Espera entre reintentos en ms (default 500). */
  backoffMs?: number;
  /** Callback opcional por reintento (para logging). */
  onRetry?: (attempt: number, error: unknown) => void;
  /** Inyectable para tests; por defecto usa setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Ejecuta `fn` reintentando SOLO ante errores de conexión transitorios
 * (`isTransientDbError`), con backoff entre intentos. Los demás errores se propagan tal
 * cual (sin reintentar). Si se agotan los reintentos, relanza el error original.
 */
export async function withDbRetry<T>(fn: () => Promise<T>, options: DbRetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 3;
  const backoffMs = options.backoffMs ?? 500;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientDbError(error)) throw error; // error no transitorio → propagar ya
      if (attempt < retries) {
        options.onRetry?.(attempt + 1, error);
        await sleep(backoffMs);
      }
    }
  }

  throw lastError; // se agotaron los reintentos → relanzar el error original
}
