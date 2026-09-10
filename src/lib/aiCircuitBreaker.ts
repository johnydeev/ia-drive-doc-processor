/**
 * Corta-corriente de la cadena de IA.
 *
 * Problema que resuelve (medido en producción, 2026-09-08 y 09): cuando los tres
 * proveedores están caídos —Gemini 429/503, Cerebras 402, OpenAI sin crédito—
 * CADA archivo redescubre el hecho barriendo la cadena entera. 23 archivos
 * gastaron 134 requests para establecer 23 veces lo mismo, y los 23 terminaron en
 * Revisión con el cartel SIN MONTO pese a ser boletas sanas.
 *
 * Al primer fallo total por infraestructura se abre el corte por `cooldownMs` y
 * las boletas siguientes vuelven a Pendientes sin gastar nada. Se re-sondea solo
 * al vencer el cooldown, porque la cuota de Gemini se recupera durante el día
 * (medido: cayó a las 09:10 y volvió a contestar a las 15:17).
 *
 * **El estado es por cliente**: las API keys viven en `googleConfigJson` de cada
 * uno, así que un cliente que quema su cuota no debe cegar a otro.
 *
 * **El estado vive en memoria del proceso** y muere con el reinicio, igual que
 * `GeminiExtractorService.workingModelName`. Es deliberado: un worker que
 * arranca de nuevo tiene que volver a probar.
 *
 * El reloj se inyecta para que los tests no esperen tiempo real. El spec
 * `2026-08-24-gemini-tier-pago-cadena-y-modelos-design.md` había descartado meter
 * tiempo en el estado; acá se hace a propósito, porque **no existe otra señal de
 * reset** — ver §8 de `2026-09-10-corta-corriente-ia-design.md`.
 */

/** 30 minutos. */
export const DEFAULT_CIRCUIT_COOLDOWN_MS = 30 * 60 * 1000;

interface OpenCircuit {
  until: number;
  reason: string;
}

export class AiCircuitBreaker {
  private readonly open = new Map<string, OpenCircuit>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly cooldownMs: number = DEFAULT_CIRCUIT_COOLDOWN_MS
  ) {}

  /** ¿El corte está activo para este cliente? Se cierra solo si venció el cooldown. */
  isOpen(clientId: string): boolean {
    return this.peek(clientId) !== null;
  }

  /** Motivo del corte mientras está abierto; `null` si está cerrado. */
  reasonFor(clientId: string): string | null {
    return this.peek(clientId)?.reason ?? null;
  }

  /** Abre el corte por `cooldownMs` a partir de ahora. Un trip nuevo lo extiende. */
  trip(clientId: string, reason: string): void {
    this.open.set(clientId, { until: this.now() + this.cooldownMs, reason });
  }

  /**
   * Cierra todos los cortes. Existe para los TESTS: el singleton de módulo vive
   * lo que vive el proceso, así que sin esto un test que abre el corte se lo
   * deja abierto a los que corren después.
   */
  reset(): void {
    this.open.clear();
  }

  /** Devuelve el corte vigente, limpiándolo si ya venció. */
  private peek(clientId: string): OpenCircuit | null {
    const circuit = this.open.get(clientId);
    if (!circuit) return null;
    if (this.now() >= circuit.until) {
      this.open.delete(clientId);
      return null;
    }
    return circuit;
  }
}

/**
 * Instancia compartida del proceso. Es la que corresponde en producción: el
 * estado tiene que sobrevivir de un archivo al siguiente dentro del ciclo del
 * worker. Los tests inyectan la suya por `ProcessingContext.aiCircuitBreaker`.
 */
export const aiCircuitBreaker = new AiCircuitBreaker();
