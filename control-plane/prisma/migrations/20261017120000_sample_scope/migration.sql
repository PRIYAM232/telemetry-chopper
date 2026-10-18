-- CreateEnum
CREATE TYPE "SampleScope" AS ENUM ('TRACE', 'SPAN');

-- AlterTable
ALTER TABLE "PolicyRule" ADD COLUMN     "sampleScope" "SampleScope";

-- AlterTable
ALTER TABLE "RuleMetric" ADD COLUMN     "evaluated" INTEGER NOT NULL DEFAULT 0;

-- Existing SAMPLE rules keep the behavior they were created with: only the
-- spans matching their condition are sampled (issue #45).
UPDATE "PolicyRule" SET "sampleScope" = 'SPAN' WHERE "actionType" = 'SAMPLE';
