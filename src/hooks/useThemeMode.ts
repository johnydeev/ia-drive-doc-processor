"use client";

import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "dark" | "light";

/** Misma clave que usaba el panel admin desde el principio: se conserva lo ya guardado. */
export const THEME_STORAGE_KEY = "dpp_admin_theme";

/**
 * Tema claro/oscuro compartido por todas las páginas del panel.
 *
 * Una sola fuente: la elección se guarda en `localStorage` y se aplica como
 * `data-theme` en `<html>`, así las páginas que tematizan por variables globales
 * (`--background` / `--foreground`) y las que lo hacen por `.page[data-theme]`
 * responden al mismo botón. Antes cada página tenía su copia y sólo el panel
 * admin persistía: al cambiar de página el tema volvía a oscuro.
 */
export function useThemeMode() {
  const [theme, setTheme] = useState<ThemeMode>("dark");

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === "dark" || stored === "light") {
        setTheme(stored);
        return;
      }
    } catch {
      /* localStorage bloqueado: se queda en el default */
    }
    const current = document.documentElement.getAttribute("data-theme");
    if (current === "light" || current === "dark") setTheme(current);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    const next: ThemeMode = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* no-op */
    }
  }, [theme]);

  return { theme, toggleTheme };
}
