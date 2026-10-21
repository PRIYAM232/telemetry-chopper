-- AlterTable
ALTER TABLE "PricingConfig" ADD COLUMN     "tracesIncludedGbPerMonth" DECIMAL(14,3) NOT NULL DEFAULT 0,
ADD COLUMN     "tracesIncludedIndexedMillionsPerMonth" DECIMAL(14,3) NOT NULL DEFAULT 0;
