import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Config de Vitest. `vite-tsconfig-paths` resuelve el alias `@/*` → `src/*`
 * leyendo tsconfig.json (robusto multiplataforma, incluido Windows).
 * Entorno node: los tests cubren librerías/lógica pura, no componentes React.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
