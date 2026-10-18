-- CreateEnum
CREATE TYPE "ThrottleScope" AS ENUM ('FLEET', 'COLLECTOR');

-- AlterTable
ALTER TABLE "PolicyRule" ADD COLUMN     "throttleBurstSeconds" INTEGER,
ADD COLUMN     "throttleScope" "ThrottleScope";

-- CreateTable
CREATE TABLE "CollectorInstance" (
    "fleetId" UUID NOT NULL,
    "instanceId" TEXT NOT NULL,
    "intervalSeconds" DOUBLE PRECISION NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectorInstance_pkey" PRIMARY KEY ("fleetId","instanceId")
);

-- CreateIndex
CREATE INDEX "CollectorInstance_lastSeenAt_idx" ON "CollectorInstance"("lastSeenAt");

-- AddForeignKey
ALTER TABLE "CollectorInstance" ADD CONSTRAINT "CollectorInstance_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "CollectorFleet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing THROTTLE rules keep the behavior they were created with: each
-- collector enforces the full rate (issue #46).
UPDATE "PolicyRule" SET "throttleScope" = 'COLLECTOR' WHERE "actionType" = 'THROTTLE';
