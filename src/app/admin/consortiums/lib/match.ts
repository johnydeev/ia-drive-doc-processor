// Helpers de normalización + matching de proveedor + deep-link. Movidos desde page.tsx.
import { cuitDigits as normCuit } from "@/lib/cuit";
import type { Provider, ScannedData } from "./types";

// normCuit: usar la fuente única lib/cuit (los CUITs de DB pueden venir con o sin guiones).
export function normName(v: string | null | undefined): string {
  return (v ?? "").toLowerCase().replace(/[.,\-_]/g, " ").replace(/\s+/g, " ").trim();
}

// ── Deep-link híbrido: URL legible + id inmutable ────────────────────────────
// El slug (del nombre) es cosmético; el matching usa el id (cuid, sin guiones)
// embebido al final → aunque renombres el consorcio, el link viejo sigue andando.
export function slugifyName(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // saca acentos (PUEYRREDÓN → pueyrredon)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
export function consortiumUrlKey(c: { id: string; canonicalName: string; rawName: string }): string {
  const slug = slugifyName(c.canonicalName || c.rawName);
  return slug ? `${slug}-${c.id}` : c.id;
}
// El id (cuid) es el último segmento tras el último guión (el cuid no tiene guiones).
export function idFromUrlKey(key: string | null | undefined): string {
  if (!key) return "";
  const idx = key.lastIndexOf("-");
  return idx >= 0 ? key.slice(idx + 1) : key;
}
export function matchProvider(providers: Provider[], extracted: ScannedData): Provider | undefined {
  if (extracted.providerTaxId) {
    const norm = normCuit(extracted.providerTaxId);
    if (norm.length >= 10) {
      const hit = providers.find((p) => normCuit(p.cuit) === norm);
      if (hit) return hit;
    }
  }
  if (extracted.provider) {
    const norm = normName(extracted.provider);
    if (norm.length >= 3) {
      const hit = providers.find((p) => normName(p.canonicalName) === norm || (p.paymentAlias && normName(p.paymentAlias) === norm));
      if (hit) return hit;
    }
  }
  return undefined;
}
