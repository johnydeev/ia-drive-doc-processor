import { useRouter } from "next/navigation";
import { useCallback } from "react";

/**
 * Devuelve un wrapper de fetch que redirige al login
 * automáticamente cuando el servidor responde 401 (sesión expirada
 * o no autenticado). Úsalo en lugar de fetch() directo en cualquier
 * componente cliente que necesite protección de sesión.
 */
export function useAuthGuard() {
  const router = useRouter();

  const guardedFetch = useCallback(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const res = await fetch(input, init);

      if (res.status === 401 || res.status === 403) {
        // Redirigir preservando la ruta actual para volver después del login
        const next = encodeURIComponent(window.location.pathname);
        router.replace(`/login?next=${next}&reason=session_expired`);
      }

      return res;
    },
    [router]
  );

  return { guardedFetch };
}
