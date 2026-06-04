export interface ClientGoogleConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  sheetsId: string;
  altaSheetsId?: string;
  /**
   * Email de un usuario de Workspace a impersonar (domain-wide delegation).
   * Necesario para que la service account pueda CREAR archivos en Drive
   * (las SA no tienen cuota propia). Si está vacío, se usa la SA directa
   * (sirve para mover/leer, pero no para crear en "Mi unidad").
   */
  impersonateEmail?: string | null;
}

export interface ClientExtractionConfig {
  sheetName?: string;
  columnMapping?: Record<string, string>;
  geminiApiKey?: string;
  openaiApiKey?: string;
  geminiModel?: string;
  openaiModel?: string;
  anthropicApiKey?: string;
  anthropicModel?: string;
  [key: string]: unknown;
}

export interface ClientDriveFolders {
  pending?: string | null;
  scanned?: string | null;
  unassigned?: string | null;
  /**
   * Carpeta para archivos que necesitan revisión manual. En Drive se la
   * suele llamar "Revisión" (más amigable para el cliente). Es el destino
   * cuando se elimina una boleta desde la UI — el archivo NO debe volver
   * a `pending` porque el scheduler lo re-procesaría y crearía la misma
   * boleta de nuevo.
   */
  failed?: string | null;
  receipts?: string | null;
  processing?: string | null;
  /**
   * Carpeta para boletas detectadas como duplicadas. Si está configurada,
   * el PDF duplicado se mueve acá (en vez de Escaneados) para revisión.
   * Los duplicados NO se escriben en Sheets ni en DB (consistencia DB↔Sheets).
   */
  duplicates?: string | null;
}

export interface ProcessingClient {
  id: string;
  name: string;
  isActive: boolean;
  batchSize: number;
  intervalMinutes: number;
  driveFoldersJson?: ClientDriveFolders | null;
  googleConfigJson?: ClientGoogleConfig | null;
  extractionConfigJson?: ClientExtractionConfig | null;
}
