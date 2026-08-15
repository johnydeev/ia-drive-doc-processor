-- Un gasto fijo por objetivo y por consorcio.
-- Postgres considera los NULL distintos entre sí, así que un gasto LSP
-- (providerId NULL) nunca colisiona con otro LSP del mismo consorcio.
CREATE UNIQUE INDEX "FixedExpense_consortiumId_providerId_key"
  ON "FixedExpense"("consortiumId", "providerId");

CREATE UNIQUE INDEX "FixedExpense_consortiumId_lspServiceId_key"
  ON "FixedExpense"("consortiumId", "lspServiceId");
