-- Fleet keys are stored as SHA-256 hashes, and a rotated-out key can stay
-- valid for a grace period. Existing keys keep working: each is replaced by
-- its own hash, so collectors need no change.

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'FLEET_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'FLEET_KEY_ROTATED';
ALTER TYPE "AuditAction" ADD VALUE 'FLEET_PREVIOUS_KEY_REVOKED';

-- AlterTable
ALTER TABLE "CollectorFleet"
    ADD COLUMN "apiKeyHash" TEXT,
    ADD COLUMN "apiKeyHint" TEXT,
    ADD COLUMN "apiKeyCreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "previousApiKeyHash" TEXT,
    ADD COLUMN "previousApiKeyHint" TEXT,
    ADD COLUMN "previousApiKeyExpiresAt" TIMESTAMP(3);

-- Same digest as hashFleetKey() in src/lib/fleet-keys.ts.
UPDATE "CollectorFleet" SET
    "apiKeyHash" = encode(sha256(convert_to("apiKey", 'UTF8')), 'hex'),
    "apiKeyHint" = right("apiKey", 4),
    "apiKeyCreatedAt" = "createdAt";

ALTER TABLE "CollectorFleet"
    ALTER COLUMN "apiKeyHash" SET NOT NULL,
    ALTER COLUMN "apiKeyHint" SET NOT NULL;

DROP INDEX "CollectorFleet_apiKey_key";
ALTER TABLE "CollectorFleet" DROP COLUMN "apiKey";

CREATE UNIQUE INDEX "CollectorFleet_apiKeyHash_key" ON "CollectorFleet"("apiKeyHash");

-- AlterTable
ALTER TABLE "CollectorInstance" ADD COLUMN "usesPreviousKey" BOOLEAN NOT NULL DEFAULT false;
