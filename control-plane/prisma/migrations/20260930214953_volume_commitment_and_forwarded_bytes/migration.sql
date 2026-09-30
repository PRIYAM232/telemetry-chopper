-- AlterTable
ALTER TABLE "FleetMetric" ADD COLUMN     "logsForwardedBytes" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "metricsForwardedBytes" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "tracesForwardedBytes" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "VolumeCommitment" (
    "fleetId" UUID NOT NULL,
    "committedGbPerMonth" DECIMAL(14,3) NOT NULL,
    "overageMultiplier" DECIMAL(5,2) NOT NULL,
    "billingCycleDay" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VolumeCommitment_pkey" PRIMARY KEY ("fleetId")
);

-- AddForeignKey
ALTER TABLE "VolumeCommitment" ADD CONSTRAINT "VolumeCommitment_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "CollectorFleet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
