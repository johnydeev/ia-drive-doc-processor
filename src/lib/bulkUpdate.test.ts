import { describe, expect, it } from "vitest";
import { buildBulkUpdate } from "./bulkUpdate";

describe("buildBulkUpdate", () => {
  it("arma un solo UPDATE ... FROM (VALUES ...) con los valores parametrizados", () => {
    const sql = buildBulkUpdate({
      table: "Provider",
      columns: [
        { name: "cuit", cast: "text" },
        { name: "matchNames", cast: "text" },
      ],
      rows: [
        { id: "p1", values: ["30-11111111-1", null] },
        { id: "p2", values: [null, "ALIAS"] },
      ],
    })!;

    expect(sql.sql).toContain('UPDATE "Provider"');
    expect(sql.sql).toContain('"cuit" = v."cuit"::text');
    expect(sql.sql).toContain('"matchNames" = v."matchNames"::text');
    expect(sql.sql).toContain("FROM (VALUES");
    expect(sql.sql).toContain('AS v("id","cuit","matchNames")');
    expect(sql.values).toEqual(["p1", "30-11111111-1", null, "p2", null, "ALIAS"]);
  });

  it("castea el enum con su tipo de Postgres", () => {
    const sql = buildBulkUpdate({
      table: "Provider",
      columns: [{ name: "providerType", cast: '"ProviderType"' }],
      rows: [{ id: "p1", values: ["EMPLEADO"] }],
    })!;
    expect(sql.sql).toContain('"providerType" = v."providerType"::"ProviderType"');
  });

  it("sin filas devuelve null: no hay nada que ejecutar", () => {
    expect(buildBulkUpdate({ table: "Provider", columns: [{ name: "cuit", cast: "text" }], rows: [] })).toBeNull();
  });
});
