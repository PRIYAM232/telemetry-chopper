-- AlterTable
ALTER TABLE "PricingConfig" ADD COLUMN     "logsIndexedSharePct" DECIMAL(5,2) NOT NULL DEFAULT 100,
ADD COLUMN     "tracesIndexedSharePct" DECIMAL(5,2) NOT NULL DEFAULT 100;
