-- AlterEnum
ALTER TYPE "PolicyAction" ADD VALUE 'EXCLUDE_INDEX';

-- AlterTable
ALTER TABLE "FleetMetric" ADD COLUMN     "logsUnindexed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tracesUnindexed" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PricingConfig" ADD COLUMN     "logsIndexPricePerMillion" DECIMAL(10,4) NOT NULL DEFAULT 0,
ADD COLUMN     "tracesIndexPricePerMillion" DECIMAL(10,4) NOT NULL DEFAULT 0;
