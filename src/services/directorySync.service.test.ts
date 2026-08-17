import { describe, expect, it, vi } from "vitest";
import { appendMatchName, syncDirectory } from "./directorySync.service";

describe("appendMatchName", () => {
  it("agrega el nombre viejo cuando no estaba", () => {
    expect(appendMatchName("FRIAS 320/24", "FRIAS 320")).toBe("FRIAS 320/24 | FRIAS 320");
  });

  it("no duplica si ya estaba, sin importar mayúsculas", () => {
    expect(appendMatchName("Frias 320 | Otro", "FRIAS 320")).toBe("Frias 320 | Otro");
  });

  it("desde vacío deja sólo el nombre", () => {
    expect(appendMatchName(null, "FRIAS 320")).toBe("FRIAS 320");
  });
});

describe("syncDirectory", () => {
  it("no ejecuta ningún deleteMany en ninguna entidad", async () => {
    const deleteMany = vi.fn();
    const createMany = vi.fn().mockResolvedValue({ count: 0 });
    const findMany = vi.fn().mockResolvedValue([]);
    const groupBy = vi.fn().mockResolvedValue([]);
    const entity = { findMany, createMany, deleteMany, groupBy, findFirst: vi.fn(), update: vi.fn() };

     
    const prisma: any = {
      consortium: entity,
      provider: entity,
      rubro: entity,
      coeficiente: entity,
      lspService: entity,
      oficio: entity,
      invoice: { groupBy },
      period: { groupBy },
       
      $transaction: async (fn: any) => fn({ ...prisma, $executeRaw: vi.fn() }),
    };

    const report = await syncDirectory(prisma, "cli1", {
      consortiums: [],
      providers: [],
      rubros: [],
      coeficientes: [],
      lspServices: [],
      oficios: [],
      warnings: [],
    });

    expect(deleteMany).not.toHaveBeenCalled();
    expect(report.consortiums.created).toBe(0);
    expect(report.pendingRenames).toEqual([]);
  });

  it("crea lo que falta y reporta lo que sobra, sin borrarlo", async () => {
    const deleteMany = vi.fn();
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const executeRaw = vi.fn();

    const consortiumRows = [
      { id: "c-viejo", canonicalName: "VIEJO 1", cuit: "30-99999999-9", matchNames: null },
    ];

    const entityVacia = {
      findMany: vi.fn().mockResolvedValue([]),
      createMany,
      deleteMany,
      findFirst: vi.fn(),
      update: vi.fn(),
    };

     
    const prisma: any = {
      consortium: { ...entityVacia, findMany: vi.fn().mockResolvedValue(consortiumRows) },
      provider: entityVacia,
      rubro: entityVacia,
      coeficiente: entityVacia,
      lspService: entityVacia,
      oficio: entityVacia,
      invoice: { groupBy: vi.fn().mockResolvedValue([{ consortiumId: "c-viejo", _count: { _all: 37 } }]) },
      period: { groupBy: vi.fn().mockResolvedValue([]) },
       
      $transaction: async (fn: any) => fn({ ...prisma, $executeRaw: executeRaw }),
    };

    const report = await syncDirectory(prisma, "cli1", {
      consortiums: [{ canonicalName: "NUEVO 2", cuit: "30-11111111-1", matchNames: null }],
      providers: [],
      rubros: [],
      coeficientes: [],
      lspServices: [],
      oficios: [],
      warnings: [],
    });

    expect(deleteMany).not.toHaveBeenCalled();
    expect(report.consortiums.created).toBe(1);
    // El sobrante se informa con cuántas boletas tiene colgando, para que el
    // aviso diga "VIEJO 1 — 37 boletas" en vez de un número pelado.
    expect(report.consortiums.orphans).toEqual([{ id: "c-viejo", name: "VIEJO 1", invoices: 37 }]);
  });

  // Prisma falso con un consorcio y un proveedor, para los tests del aviso de tipo.
  function prismaConServicio(providerType: "PROVEEDOR" | "EMPLEADO" | "SERVICIO") {
    const entity = {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    };

    const prisma: any = {
      consortium: {
        ...entity,
        findMany: vi.fn().mockResolvedValue([
          { id: "c1", canonicalName: "FRIAS 324", cuit: null, matchNames: null },
        ]),
      },
      provider: {
        ...entity,
        findMany: vi.fn().mockResolvedValue([
          { id: "p1", canonicalName: "EDESUR S.A.", cuit: null, matchNames: null, paymentAlias: null, providerType },
        ]),
      },
      rubro: entity,
      coeficiente: entity,
      lspService: entity,
      oficio: entity,
      invoice: { groupBy: vi.fn().mockResolvedValue([]) },
      period: { groupBy: vi.fn().mockResolvedValue([]) },
      $transaction: async (fn: any) => fn({ ...prisma, $executeRaw: vi.fn() }),
    };
    return prisma;
  }

  const directorioConServicio = {
    consortiums: [{ canonicalName: "FRIAS 324", cuit: null, matchNames: null }],
    providers: [],
    rubros: [],
    coeficientes: [],
    lspServices: [
      { consortiumName: "FRIAS 324", provider: "EDESUR S.A.", clientNumber: "1061158", description: null },
    ],
    oficios: [],
    warnings: [],
  };

  it("avisa cuando un servicio apunta a un proveedor que no es SERVICIO, pero lo crea igual", async () => {
    const report = await syncDirectory(prismaConServicio("PROVEEDOR"), "cli1", directorioConServicio);

    expect(report.warnings.some((w) => w.includes("no está marcado como SERVICIO"))).toBe(true);
    expect(report.lspServices.created).toBe(1);
  });

  it("un proveedor marcado SERVICIO no genera aviso", async () => {
    const report = await syncDirectory(prismaConServicio("SERVICIO"), "cli1", directorioConServicio);

    expect(report.warnings).toEqual([]);
    expect(report.lspServices.created).toBe(1);
  });

  it("resuelve el oficio por nombre y avisa cuando no está en el catálogo", async () => {
    const entity = {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    };

    const prisma: any = {
      consortium: entity,
      provider: entity,
      rubro: entity,
      coeficiente: entity,
      lspService: entity,
      oficio: {
        ...entity,
        findMany: vi
          .fn()
          .mockResolvedValueOnce([]) // foto previa: el catálogo está vacío
          .mockResolvedValueOnce([{ id: "of1", name: "PINTOR" }]), // tras crearlo
      },
      invoice: { groupBy: vi.fn().mockResolvedValue([]) },
      period: { groupBy: vi.fn().mockResolvedValue([]) },
      $transaction: async (fn: any) => fn({ ...prisma, $executeRaw: vi.fn() }),
    };

    const report = await syncDirectory(prisma, "cli1", {
      consortiums: [],
      providers: [
        { canonicalName: "JUAN PINTURAS", cuit: null, matchNames: null, paymentAlias: null, providerType: "PROVEEDOR", oficioName: "PINTOR" },
        { canonicalName: "OTRO", cuit: null, matchNames: null, paymentAlias: null, providerType: "PROVEEDOR", oficioName: "SOLDADOR" },
      ],
      rubros: [],
      coeficientes: [],
      lspServices: [],
      oficios: [{ name: "PINTOR", description: null }],
      warnings: [],
    });

    expect(report.oficios.created).toBe(1);
    expect(report.warnings.some((w) => w.includes('"SOLDADOR"'))).toBe(true);
    expect(report.warnings.some((w) => w.includes('"PINTOR"'))).toBe(false);
  });
});
