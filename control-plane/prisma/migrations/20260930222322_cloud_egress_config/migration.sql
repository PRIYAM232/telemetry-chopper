-- CreateTable
CREATE TABLE "EgressConfig" (
    "fleetId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "pricePerGb" DECIMAL(10,4) NOT NULL DEFAULT 0.09,
    "compressionRatio" DECIMAL(6,2) NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EgressConfig_pkey" PRIMARY KEY ("fleetId")
);

-- AddForeignKey
ALTER TABLE "EgressConfig" ADD CONSTRAINT "EgressConfig_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "CollectorFleet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
