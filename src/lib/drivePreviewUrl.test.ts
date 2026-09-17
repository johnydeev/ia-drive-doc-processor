import { describe, expect, it } from "vitest";
import { toDrivePreviewUrl } from "./drivePreviewUrl";

describe("toDrivePreviewUrl", () => {
  it("convierte /file/d/<id>/view en /preview", () => {
    expect(toDrivePreviewUrl("https://drive.google.com/file/d/ABC123/view?usp=drivesdk"))
      .toBe("https://drive.google.com/file/d/ABC123/preview");
  });

  it("acepta el formato ?id=<id>", () => {
    expect(toDrivePreviewUrl("https://drive.google.com/open?id=XYZ&x=1"))
      .toBe("https://drive.google.com/file/d/XYZ/preview");
  });

  it("deja pasar lo que no reconoce", () => {
    expect(toDrivePreviewUrl("https://example.com/boleta.pdf")).toBe("https://example.com/boleta.pdf");
  });
});
