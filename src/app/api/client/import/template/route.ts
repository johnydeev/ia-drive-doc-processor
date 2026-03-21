import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";

/**
 * GET /api/client/import/template
 * Descarga un archivo Excel de plantilla con las dos hojas vacías
 * (Edificios y Proveedores) con sus encabezados correctos.
 */
export async function GET(request: NextRequest) {
  const auth = requireClientSession(request);
  if (auth.error) return auth.error;

  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();

  // Hoja Edificios
  const wsEdificios = XLSX.utils.aoa_to_sheet([
    ["Nombre", "CUIT", "Aliases"],
    ["ARENALES 2154", "30-52312872-4", "CONS PROP ARENALES 2154|ARENALES 2154 56"],
    ["PUEYRREDON 2418", "30-71478725-6", ""],
  ]);
  // Ancho de columnas
  wsEdificios["!cols"] = [{ wch: 35 }, { wch: 18 }, { wch: 50 }];
  XLSX.utils.book_append_sheet(wb, wsEdificios, "Edificios");

  // Hoja Proveedores
  const wsProveedores = XLSX.utils.aoa_to_sheet([
    ["Nombre", "CUIT", "Alias"],
    ["TIGRE ASCENSORES S.A.", "27-33906838-6", "TIGRE ASCENSORES"],
    ["EDESUR", "30-65651651-2", ""],
  ]);
  wsProveedores["!cols"] = [{ wch: 35 }, { wch: 18 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, wsProveedores, "Proveedores");

  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="plantilla_importacion.xlsx"',
    },
  });
}
