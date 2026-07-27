import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthGuard } from "@/lib/useAuthGuard";

export function useSession() {
  const router = useRouter();
  const { guardedFetch } = useAuthGuard();
  const [accessChecked, setAccessChecked] = useState(false);
  const [userName, setUserName] = useState("");
  const [userRole, setUserRole] = useState<string>("");
  const [consortiumsEnabled, setConsortiumsEnabled] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await guardedFetch("/api/auth/me", { method: "GET", cache: "no-store" });
        const data = (await res.json()) as { ok: boolean; user?: { name?: string; role?: string; consortiumsEnabled?: boolean } };
        if (!data.ok || !data.user?.consortiumsEnabled) { router.replace("/admin"); return; }
        setUserName(data.user.name ?? data.user.role ?? "");
        setUserRole(data.user.role ?? "");
        setConsortiumsEnabled(data.user.consortiumsEnabled ?? false);
        setAccessChecked(true);
      } catch { router.replace("/admin"); }
    })();
  }, [guardedFetch, router]);

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.push("/login");
      router.refresh();
    } catch { /* silent */ }
  };

  return { accessChecked, userName, userRole, consortiumsEnabled, handleLogout };
}
