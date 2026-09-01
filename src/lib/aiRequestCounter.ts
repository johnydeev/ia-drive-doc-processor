/**
 * Cuenta las requests HTTP que se le hacen a la IA mientras se procesa UNA boleta.
 *
 * La cuota del free tier de Gemini se gasta por request y **por modelo** (~20/día
 * cada uno), así que un total agregado no alcanza: hay que saber cuál de los
 * baldes se vació. El barrido de modelos de `GeminiExtractorService` puede gastar
 * hasta 6 requests dentro de un solo "intento" de la cadena (3 modelos × el
 * reintento por 503), y `TokenUsage` no registra llamadas: guarda una fila por
 * corrida, no por request.
 *
 * **Regla: incrementa quien hace la llamada HTTP, nunca el orquestador.** Si
 * contara `AiExtractionChain.run`, un barrido de 3 modelos contaría 1 — y habría
 * que acordarse de arreglarlo el día que otro extractor agregue un retry interno.
 */
export class AiRequestCounter {
  private readonly counts = new Map<string, number>();

  record(provider: string, model: string): void {
    const key = `${provider}:${model || "unknown"}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  total(): number {
    let sum = 0;
    for (const n of this.counts.values()) sum += n;
    return sum;
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }
}
