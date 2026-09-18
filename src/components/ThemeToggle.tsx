"use client";

import type { ThemeMode } from "@/hooks/useThemeMode";
import styles from "./ThemeToggle.module.css";

type Props = {
  theme: ThemeMode;
  onToggle: () => void;
  className?: string;
  disabled?: boolean;
};

const Sun = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
);

const Moon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" />
  </svg>
);

/**
 * Interruptor claro/oscuro. `role="switch"` con `aria-checked` = modo oscuro
 * activo. La perilla muestra el ícono del modo al que se pasa: sol en modo
 * oscuro, luna en modo claro. Sólo toggle local (sin spinner: no hay mutación).
 * `className` se suma a la pista para ubicarlo en cada barra.
 */
export function ThemeToggle({ theme, onToggle, className, disabled }: Props) {
  const dark = theme === "dark";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label="Modo oscuro"
      title={dark ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
      className={className ? `${styles.switch} ${className}` : styles.switch}
      onClick={onToggle}
      disabled={disabled}
    >
      <Sun className={`${styles.trackIcon} ${styles.trackSun}`} />
      <Moon className={`${styles.trackIcon} ${styles.trackMoon}`} />
      <span className={styles.knob}>{dark ? <Sun /> : <Moon />}</span>
    </button>
  );
}
