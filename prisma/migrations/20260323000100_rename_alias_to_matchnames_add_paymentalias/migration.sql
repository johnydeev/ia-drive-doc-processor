-- Rename Provider.alias → Provider.matchNames and add paymentAlias
ALTER TABLE "Provider" RENAME COLUMN "alias" TO "matchNames";
ALTER TABLE "Provider" ADD COLUMN "paymentAlias" TEXT;

-- Rename Consortium.aliases → Consortium.matchNames and add paymentAlias
ALTER TABLE "Consortium" RENAME COLUMN "aliases" TO "matchNames";
ALTER TABLE "Consortium" ADD COLUMN "paymentAlias" TEXT;
