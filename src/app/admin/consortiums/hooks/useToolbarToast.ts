import { useEffect, useState } from "react";

export function useToolbarToast() {
  const [toolbarInfo, setToolbarInfo] = useState<string | null>(null);
  const [toolbarError, setToolbarError] = useState<string | null>(null);

  useEffect(() => {
    if (!toolbarInfo) return;
    const t = setTimeout(() => setToolbarInfo(null), 4000);
    return () => clearTimeout(t);
  }, [toolbarInfo]);
  useEffect(() => {
    if (!toolbarError) return;
    const t = setTimeout(() => setToolbarError(null), 5000);
    return () => clearTimeout(t);
  }, [toolbarError]);

  return { toolbarInfo, toolbarError, setToolbarInfo, setToolbarError };
}
