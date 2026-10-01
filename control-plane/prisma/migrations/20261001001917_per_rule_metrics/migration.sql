-- CreateTable
CREATE TABLE "RuleMetric" (
    "id" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "matched" INTEGER NOT NULL,
    "dropped" INTEGER NOT NULL,
    "droppedBytes" BIGINT NOT NULL,
    "unindexed" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RuleMetric_fleetId_createdAt_idx" ON "RuleMetric"("fleetId", "createdAt");

-- AddForeignKey
ALTER TABLE "RuleMetric" ADD CONSTRAINT "RuleMetric_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "CollectorFleet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleMetric" ADD CONSTRAINT "RuleMetric_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "PolicyRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
