/**
 * Convierte un link de Drive (`/file/d/<id>/view`, `?id=<id>`) en la URL
 * embebible `/file/d/<id>/preview` para un iframe. Si no reconoce el formato,
 * devuelve la URL tal cual.
 */
export function toDrivePreviewUrl(url: string): string {
  const m = url.match(/\/d\/([^/]+)/) ?? url.match(/[?&]id=([^&]+)/);
  const id = m?.[1];
  return id ? `https://drive.google.com/file/d/${id}/preview` : url;
}
