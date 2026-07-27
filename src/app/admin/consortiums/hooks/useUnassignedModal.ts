import { useState } from "react";
import { useAuthGuard } from "@/lib/useAuthGuard";

type UnassignedFile = { id: string; name: string };
type UnassignedResult = { moved: number; failed: number };

export function useUnassignedModal() {
  const { guardedFetch } = useAuthGuard();
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<"preview" | "result">("preview");
  const [files, setFiles] = useState<UnassignedFile[]>([]);
  const [folderConfigured, setFolderConfigured] = useState(true);
  const [result, setResult] = useState<UnassignedResult | null>(null);
  const [loading, setLoading] = useState(false);

  const open = async () => {
    setIsOpen(true); setStep("preview"); setResult(null); setFiles([]); setFolderConfigured(true);
    setLoading(true);
    try {
      const res = await guardedFetch("/api/client/unassigned/preview", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setFolderConfigured(data.folderConfigured ?? false);
      setFiles(data.files ?? []);
    } catch {
      setFolderConfigured(false);
      setFiles([]);
    } finally { setLoading(false); }
  };

  const requeue = async () => {
    setLoading(true);
    try {
      const res = await guardedFetch("/api/client/unassigned/requeue", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResult({ moved: data.moved ?? 0, failed: data.failed ?? 0 });
      setStep("result");
    } catch {
      setResult({ moved: 0, failed: files.length });
      setStep("result");
    } finally { setLoading(false); }
  };

  const close = () => setIsOpen(false);

  return { isOpen, step, files, folderConfigured, result, loading, open, requeue, close };
}
