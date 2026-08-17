import { Prisma } from "@prisma/client";

export type BulkColumn = {
  /** Nombre de la columna tal cual está en la base. */
  name: string;
  /** Cast de Postgres para el valor parametrizado (`text`, `"ProviderType"`, …). */
  cast: string;
};

export type BulkRow = { id: string; values: unknown[] };

/**
 * Arma un único `UPDATE ... FROM (VALUES ...)` para escribir N filas en una sola
 * query. Reemplaza a los N `tx.update` del sync, que eran N round-trips en serie
 * (~500 ms cada uno) y llevaban el endpoint a 120 s contra los 100 s del túnel.
 *
 * Los VALORES van siempre parametrizados. Los identificadores (tabla y columnas)
 * se interpolan con `Prisma.raw` y por eso deben venir de constantes del código,
 * nunca de entrada del usuario.
 *
 * Devuelve `null` cuando no hay filas: no hay query que correr.
 */
export function buildBulkUpdate({
  table,
  columns,
  rows,
}: {
  table: string;
  columns: BulkColumn[];
  rows: BulkRow[];
}): Prisma.Sql | null {
  if (rows.length === 0 || columns.length === 0) return null;

  const setClause = Prisma.join(
    columns.map((c) => Prisma.raw(`"${c.name}" = v."${c.name}"::${c.cast}`)),
    ", "
  );

  const tuples = Prisma.join(
    rows.map((r) => Prisma.sql`(${Prisma.join([r.id, ...r.values] as never[])})`),
    ", "
  );

  const columnList = Prisma.raw(['"id"', ...columns.map((c) => `"${c.name}"`)].join(","));

  return Prisma.sql`
    UPDATE ${Prisma.raw(`"${table}"`)} AS t
    SET ${setClause}
    FROM (VALUES ${tuples}) AS v(${columnList})
    WHERE t."id" = v."id"::text
  `;
}
