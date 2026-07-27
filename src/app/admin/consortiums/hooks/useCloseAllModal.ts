import { useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";
import type { CloseAllPreview } from "../lib/types";

type CloseAllResult = { closed: number; skipped: number; warnings: string[] };

export function useCloseAllModal({ onExecuted }: { onExecuted: () => void }) {
  const { guardedFetch } = useAuthGuard();
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<"preview" | "result">("preview");
  const [preview, setPreview] = useState<CloseAllPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CloseAllResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    setLoading(true); setError(null); setResult(null); setStep("preview");
    try {
      const res = await guardedFetch("/api/client/periods/close-all/preview", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setPreview(data);
      setIsOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
      setIsOpen(true);
    } finally { setLoading(false); }
  };

  const execute = async () => {
    setLoading(true); setError(null);
    try {
      const res = await guardedFetch("/api/client/periods/close-all", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResult({ closed: data.closed, skipped: data.skipped, warnings: data.warnings ?? [] });
      setStep("result");
      onExecuted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally { setLoading(false); }
  };

  const close = () => setIsOpen(false);

  return { isOpen, step, preview, loading, result, error, open, execute, close };
}
