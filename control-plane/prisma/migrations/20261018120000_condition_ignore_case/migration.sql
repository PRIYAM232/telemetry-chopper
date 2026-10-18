-- AlterEnum
ALTER TYPE "ConditionOp" ADD VALUE 'LESS_THAN';

-- AlterTable
ALTER TABLE "PolicyRule" ADD COLUMN     "conditionIgnoreCase" BOOLEAN NOT NULL DEFAULT false;
