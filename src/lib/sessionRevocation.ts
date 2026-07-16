import { ClientRole } from "@prisma/client";
import { getPrismaClient } from "@/lib/prisma";

/**
 * Re-verificación de sesiones contra la DB con cache en memoria.
 *
 * El JWT dura 24h y no hay revocación server-side: sin este chequeo, un cliente
 * desactivado (o con rol degradado) retiene acceso a la API hasta que expira el
 * token. Acá se consulta `Client.isActive`/`role` como máximo una vez por TTL
 * (60s) por cliente: desactivar hace efecto en ≤60s con costo despreciable.
 *
 * Fallos de DB (blip del pooler): se usa la última entrada de cache aunque esté
 * vencida (no echar sesiones válidas por un blip); si nunca se vio al cliente,
 * se rechaza (fail-closed).
 *
 * NOTA: cache por proceso. Producción corre 1 solo contenedor `web`, así que no
 * hay problema de coherencia. Si algún día se escala horizontal, cada instancia
 * converge sola en ≤TTL — revisar si eso alcanza.
 */

export interface SessionAccount {
  isActive: boolean;
  role: ClientRole;
}

interface CacheEntry {
  account: SessionAccount | null; // null = cliente inexistente
  fetchedAt: number;
}

const DEFAULT_TTL_MS = 60_000;

export function createSessionValidityResolver(opts: {
  fetchAccount: (clientId: string) => Promise<SessionAccount | null>;
  ttlMs?: number;
  now?: () => number;
}): (clientId: string) => Promise<SessionAccount | null> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  return async function resolveSessionValidity(clientId: string): Promise<SessionAccount | null> {
    const cached = cache.get(clientId);
    if (cached && now() - cached.fetchedAt < ttlMs) {
      return cached.account?.isActive ? cached.account : null;
    }

    let account: SessionAccount | null;
    try {
      account = await opts.fetchAccount(clientId);
    } catch {
      // Blip de DB: última verdad conocida (aunque vencida) antes que echar a todos.
      if (cached) return cached.account?.isActive ? cached.account : null;
      return null;
    }

    cache.set(clientId, { account, fetchedAt: now() });
    return account?.isActive ? account : null;
  };
}

async function fetchAccountFromDb(clientId: string): Promise<SessionAccount | null> {
  const prisma = getPrismaClient();
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { isActive: true, role: true },
  });
  return client ?? null;
}

/** Instancia por defecto usada por los guards de auth. */
export const resolveSessionValidity = createSessionValidityResolver({ fetchAccount: fetchAccountFromDb });
