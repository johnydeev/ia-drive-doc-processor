import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { THEME_STORAGE_KEY, useThemeMode } from "./useThemeMode";

// jsdom en este proyecto no trae un localStorage usable (origen opaco): se
// reemplaza por uno en memoria con la misma interfaz.
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => { data.delete(k); },
    setItem: (k, v) => { data.set(k, String(v)); },
  };
}

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
  Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
});

describe("useThemeMode", () => {
  it("default oscuro y lo escribe como data-theme en el html", () => {
    const { result } = renderHook(() => useThemeMode());
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("arranca con lo guardado en localStorage", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    const { result } = renderHook(() => useThemeMode());
    expect(result.current.theme).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("sin nada guardado, respeta un data-theme ya puesto en el html", () => {
    document.documentElement.setAttribute("data-theme", "light");
    const { result } = renderHook(() => useThemeMode());
    expect(result.current.theme).toBe("light");
  });

  it("toggle alterna, persiste y actualiza el html", () => {
    const { result } = renderHook(() => useThemeMode());
    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });
});
