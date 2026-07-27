import { useEffect, useState } from "react";
import type { ThemeMode } from "../lib/types";

export function useTheme() {
  const [theme, setTheme] = useState<ThemeMode>("dark");
  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    if (current === "light" || current === "dark") setTheme(current);
  }, []);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  return { theme };
}
