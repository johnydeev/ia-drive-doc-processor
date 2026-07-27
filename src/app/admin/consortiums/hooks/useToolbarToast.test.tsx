import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useToolbarToast } from "./useToolbarToast";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useToolbarToast", () => {
  it("autodismiss del info a los 4s", () => {
    const { result } = renderHook(() => useToolbarToast());
    act(() => result.current.setToolbarInfo("hola"));
    expect(result.current.toolbarInfo).toBe("hola");
    act(() => vi.advanceTimersByTime(4000));
    expect(result.current.toolbarInfo).toBeNull();
  });
});
