/**
 * Corrida selectiva: reglas de qué boletas se pueden elegir y cuántas.
 *
 * Lógica pura — la usan el endpoint que arma la lista del modal y el que encola.
 * El tope vive acá y no en la UI: un tope que solo existe en el navegador no es
 * un tope.
 */

/** Máximo de boletas por corrida. */
export const MAX_MANUAL_RUN_FILES = 10;

/** Por qué una boleta no se puede elegir. */
export type ManualRunFileStatus =
  /** Se puede encolar. */
  | "available"
  /** Ya tiene un job en curso (PENDING o PROCESSING). */
  | "queued"
  /** Ya tiene una boleta cargada: el archivo quedó en Pendientes por otra razón. */
  | "loaded";

export interface ManualRunFile {
  id: string;
  name: string;
  mimeType: string;
  status: ManualRunFileStatus;
}

export interface DriveFileLike {
  id: string;
  name: string;
  mimeType: string;
}

/**
 * Arma la lista del modal. Se muestran TODOS los archivos de Pendientes, marcando
 * los que no se pueden elegir — así el owner ve qué hay encolado en vez de que
 * desaparezca de la lista sin explicación.
 */
export function buildManualRunList(
  files: DriveFileLike[],
  queuedFileIds: Set<string>,
  loadedFileIds: Set<string>
): ManualRunFile[] {
  return files.map((file) => ({
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    status: queuedFileIds.has(file.id)
      ? "queued"
      : loadedFileIds.has(file.id)
        ? "loaded"
        : "available",
  }));
}

export type SelectionResult =
  | { ok: true; fileIds: string[] }
  | { ok: false; error: string };

/**
 * Valida la selección contra la lista real de Pendientes. Rechaza la corrida
 * entera ante cualquier id inválido en vez de encolar una parte: si el modal y el
 * servidor no coinciden, es mejor que el owner refresque a que corra algo que no
 * eligió.
 */
export function validateSelection(fileIds: string[], list: ManualRunFile[]): SelectionResult {
  const unique = [...new Set(fileIds)];

  if (unique.length === 0) {
    return { ok: false, error: "No se seleccionó ninguna boleta" };
  }
  if (unique.length > MAX_MANUAL_RUN_FILES) {
    return { ok: false, error: `Máximo ${MAX_MANUAL_RUN_FILES} boletas por corrida` };
  }

  const byId = new Map(list.map((file) => [file.id, file]));

  for (const id of unique) {
    const file = byId.get(id);
    if (!file) {
      return { ok: false, error: `El archivo ${id} ya no está en Pendientes — refrescá la lista` };
    }
    if (file.status !== "available") {
      return { ok: false, error: `"${file.name}" no se puede encolar (${file.status})` };
    }
  }

  return { ok: true, fileIds: unique };
}
