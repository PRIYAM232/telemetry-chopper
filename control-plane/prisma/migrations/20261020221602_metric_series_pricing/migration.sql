-- AlterTable
ALTER TABLE "PricingConfig" ADD COLUMN     "metricsPricePer100Series" DECIMAL(10,4) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "MetricSeriesHour" (
    "fleetId" UUID NOT NULL,
    "collectorId" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "droppedSeries" INTEGER NOT NULL,

    CONSTRAINT "MetricSeriesHour_pkey" PRIMARY KEY ("fleetId","collectorId","hour")
);

-- CreateIndex
CREATE INDEX "MetricSeriesHour_fleetId_hour_idx" ON "MetricSeriesHour"("fleetId", "hour");

-- AddForeignKey
ALTER TABLE "MetricSeriesHour" ADD CONSTRAINT "MetricSeriesHour_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "CollectorFleet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
