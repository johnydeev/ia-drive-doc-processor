/**
 * Utilidades para clasificar errores de los proveedores de IA.
 *
 * El caso crítico es el **rate-limit / cuota agotada (HTTP 429)**: es un error
 * transitorio (la cuota se recupera), distinto de un error de contenido. El
 * pipeline lo trata aparte para no "perder" la boleta (la deja en Pendientes
 * para reintentar) y los extractores evitan reintentos inútiles.
 */

/** Error transitorio de rate-limit / cuota agotada de un proveedor de IA. */
export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

/**
 * Devuelve true si el error parece un rate-limit / cuota agotada (429).
 * Acepta `Error`, string o cualquier valor. Usa `\b429\b` para no confundir
 * un "1429"/"4290" con el código HTTP 429.
 */
export function isRateLimitError(error: unknown): boolean {
  if (error instanceof RateLimitError) return true;
  if (error === null || error === undefined) return false;

  // El SDK de OpenAI (OpenAI/Cerebras) lanza APIError con `status` numérico
  // y/o `code`. Cerebras puede no incluir "429" en el mensaje, así que el
  // status es la señal fiable.
  if (typeof error === "object") {
    const e = error as { status?: unknown; code?: unknown };
    if (e.status === 429) return true;
    if (e.code === "rate_limit_exceeded" || e.code === "insufficient_quota") return true;
  }

  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();

  return (
    /\b429\b/.test(text) ||
    text.includes("too many requests") ||
    text.includes("resource_exhausted") ||
    text.includes("quota") ||
    // Mensajes propios en español (p. ej. el RateLimitError del barrido de
    // modelos: "sin cuota en los N modelo(s)"). La cadena de IA propaga el
    // MENSAJE (string) al pipeline, así que el matcher debe reconocerlos.
    text.includes("sin cuota") ||
    text.includes("cuota agotada")
  );
}

/**
 * Devuelve true si el error es una caída transitoria DEL LADO DEL PROVEEDOR
 * (HTTP 503 / servicio saturado), distinta de la cuota agotada (429) que ya
 * clasifica `isRateLimitError`.
 *
 * La distinción importa: ante 429 no tiene sentido reintentar el mismo modelo
 * (la cuota no vuelve en 2 segundos), ante 503 sí (es capacidad momentánea).
 *
 * Se usa `\b503\b` por el mismo motivo que el 429: no confundir un "5030".
 * El 404 de un modelo dado de baja dice "no longer available", que NO contiene
 * la subcadena "unavailable" — por eso no da falso positivo.
 */
export function isTransientServerError(error: unknown): boolean {
  if (error === null || error === undefined) return false;

  if (typeof error === "object") {
    const e = error as { status?: unknown };
    if (e.status === 503) return true;
  }

  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();

  return (
    /\b503\b/.test(text) ||
    text.includes("service unavailable") ||
    text.includes("unavailable") ||
    text.includes("overloaded") ||
    text.includes("high demand")
  );
}

export interface RetryOptions {
  /** Reintentos adicionales ante rate-limit (default 1). */
  retries?: number;
  /** Espera entre reintentos en ms (default 3000). */
  backoffMs?: number;
  /** Inyectable para tests; por defecto usa setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Ejecuta `fn` reintentando SOLO ante rate-limit (429), con backoff entre
 * intentos. Los errores normales se propagan tal cual (sin reintentar). Si se
 * agotan los reintentos por rate-limit, lanza `RateLimitError` (para que el
 * caller pueda distinguirlo y, p. ej., dejar la boleta en Pendientes).
 */
export async function callWithRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 1;
  const backoffMs = options.backoffMs ?? 3000;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error)) throw error; // error normal → propagar ya
      if (attempt < retries) await sleep(backoffMs); // queda al menos un reintento
    }
  }

  throw new RateLimitError(lastError instanceof Error ? lastError.message : String(lastError));
}

/**
 * Devuelve true si el proveedor **no está disponible para nosotros**: sin
 * crédito, sin plan, pago requerido (HTTP 402). Es distinto de la cuota agotada
 * (429, `isRateLimitError`) y de la caída transitoria (503,
 * `isTransientServerError`), y la diferencia importa:
 *
 * El guard de `aiExtractStep` exige que TODAS las fallas de la cadena sean de
 * infraestructura para devolver la boleta a Pendientes. Cerebras devolviendo
 * `402 status code (no body)` no matcheaba ninguna de las dos clasificaciones
 * anteriores, así que la condición nunca se cumplía y 23 boletas sanas fueron a
 * Revisión con el cartel SIN MONTO (medido en producción, 2026-09-08/09).
 *
 * Se usa `\b402\b` por el mismo motivo que el 429 y el 503: no confundir un "4020".
 */
export function isProviderDownError(error: unknown): boolean {
  if (error === null || error === undefined) return false;

  if (typeof error === "object") {
    const e = error as { status?: unknown };
    if (e.status === 402) return true;
  }

  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();

  return (
    /\b402\b/.test(text) ||
    text.includes("no credits") ||
    text.includes("payment required")
  );
}

/**
 * ¿La falla es de INFRAESTRUCTURA (el proveedor no pudo atender) y no de
 * contenido (el documento rompió la extracción)?
 *
 * Es la unión de las tres clasificaciones, y es lo que decide si la boleta
 * vuelve a Pendientes o degrada a OCR_ONLY. Fuente única: la cadena de IA y el
 * pipeline la comparten para no reimplementar el criterio en dos lugares.
 */
export function isInfrastructureFailure(error: unknown): boolean {
  return isRateLimitError(error) || isTransientServerError(error) || isProviderDownError(error);
}

/**
 * El corta-corriente frenó la boleta ANTES de intentar la IA.
 *
 * Hereda de `RateLimitError` para reusar su camino en el pipeline —la boleta
 * vuelve a Pendientes y el job cierra OK, sin consumir reintentos— pero se
 * distingue para poder medirlo aparte en `ProcessingJob.reasonCategory`: son las
 * boletas que el corte salvó sin gastar una sola request.
 */
export class CircuitOpenError extends RateLimitError {
  constructor(message: string) {
    super(message);
    this.name = "CircuitOpenError";
  }
}
