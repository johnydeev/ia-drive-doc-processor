import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Config de Vitest. `vite-tsconfig-paths` resuelve el alias `@/*` → `src/*`
 * leyendo tsconfig.json (robusto multiplataforma, incluido Windows).
 *
 * Dos proyectos por extensión de archivo:
 *  - "node":  lógica pura de librerías/backend (*.test.ts).
 *  - "jsdom": hooks y componentes React (*.test.tsx) con testing-library.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["./vitest.setup.ts"],
        },
      },
    ],
  },
});
