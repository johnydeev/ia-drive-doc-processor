/**
 * Shim para tipos Canvas/DOM que faltan en el contexto de jobs (no incluye "dom" lib).
 * Necesario porque ocr.service.ts referencia CanvasRenderingContext2D
 * y es importado (dinámicamente) desde pdfTextExtractor.service.ts.
 */
/* eslint-disable @typescript-eslint/no-empty-object-type */
declare interface CanvasRenderingContext2D {}
declare interface RequestInfo {}
