"use client";

import { useEffect } from "react";
import { toDrivePreviewUrl } from "@/lib/drivePreviewUrl";

export type PdfPreview = {
  /** Link de Drive de la boleta (`/file/d/<id>/view`). Se embebe como `/preview`. */
  sourceUrl: string;
  title: string;
};

type Props = {
  preview: PdfPreview | null;
  onClose: () => void;
};

/**
 * Vista previa de un PDF de Drive en un iframe, con link para abrirlo en Drive.
 * Cierra con Escape o click afuera. Compartido por Boletas entrantes y Obligaciones.
 */
export function PdfPreviewModal({ preview, onClose }: Props) {
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview, onClose]);

  if (!preview) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={preview.title}
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.7)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: "24px",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(900px, 92vw)", height: "90vh",
          background: "#0f1629", border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 12, display: "flex", flexDirection: "column",
          overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 12, padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.1)",
        }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "#eef2ff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {preview.title}
          </span>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <a
              href={preview.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 13, color: "#7aaeff", textDecoration: "none", padding: "6px 10px", border: "1px solid rgba(91,140,247,0.35)", borderRadius: 8 }}
            >
              Abrir en Drive ↗
            </a>
            <button
              type="button"
              onClick={onClose}
              style={{ fontSize: 16, color: "#c8d8ff", background: "none", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, width: 34, height: 34, cursor: "pointer" }}
              aria-label="Cerrar vista previa"
            >
              ✕
            </button>
          </div>
        </div>
        <iframe
          src={toDrivePreviewUrl(preview.sourceUrl)}
          title="Vista previa de boleta"
          style={{ flex: 1, width: "100%", border: "none", background: "#fff" }}
          allow="autoplay"
        />
      </div>
    </div>
  );
}
