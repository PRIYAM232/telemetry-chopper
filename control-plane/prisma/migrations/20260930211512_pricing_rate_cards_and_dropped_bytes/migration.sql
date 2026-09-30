-- CreateEnum
CREATE TYPE "ObservabilityVendor" AS ENUM ('DATADOG', 'SPLUNK', 'NEW_RELIC', 'CUSTOM');

-- AlterTable
ALTER TABLE "FleetMetric" ADD COLUMN     "logsDroppedBytes" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "metricsDroppedBytes" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "tracesDroppedBytes" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PricingConfig" (
    "fleetId" UUID NOT NULL,
    "vendor" "ObservabilityVendor" NOT NULL,
    "customVendorName" TEXT,
    "tracesPricePerGb" DECIMAL(10,4) NOT NULL,
    "logsPricePerGb" DECIMAL(10,4) NOT NULL,
    "metricsPricePerGb" DECIMAL(10,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingConfig_pkey" PRIMARY KEY ("fleetId")
);

-- AddForeignKey
ALTER TABLE "PricingConfig" ADD CONSTRAINT "PricingConfig_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "CollectorFleet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
