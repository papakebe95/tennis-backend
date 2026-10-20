-- CreateEnum
CREATE TYPE "MatchConfirmation" AS ENUM ('NOT_REGISTERED', 'PENDING', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MatchValidation" AS ENUM ('PENDING', 'VALIDATED', 'REJECTED');

-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "player1Confirmation" "MatchConfirmation" NOT NULL DEFAULT 'CONFIRMED',
ADD COLUMN     "player1Name" TEXT,
ADD COLUMN     "player1RejectReason" TEXT,
ADD COLUMN     "player1RespondedAt" TIMESTAMP(3),
ADD COLUMN     "player2Confirmation" "MatchConfirmation" NOT NULL DEFAULT 'NOT_REGISTERED',
ADD COLUMN     "player2RejectReason" TEXT,
ADD COLUMN     "player2RespondedAt" TIMESTAMP(3),
ADD COLUMN     "recordedById" TEXT,
ADD COLUMN     "refereed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "validation" "MatchValidation" NOT NULL DEFAULT 'VALIDATED',
ALTER COLUMN "player1Id" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Match_recordedById_startedAt_idx" ON "Match"("recordedById", "startedAt");

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: existing matches keep counting exactly as before. The recording
-- player is player1; a registered opponent is treated as having confirmed.
-- Tournament results (linked to a CompetitionMatch) were validated in the
-- back-office, so they have no recorder.
UPDATE "Match" m SET "recordedById" = m."player1Id"
WHERE NOT EXISTS (SELECT 1 FROM "CompetitionMatch" c WHERE c."linkedMatchId" = m."id");

UPDATE "Match" SET "player2Confirmation" = 'CONFIRMED' WHERE "player2Id" IS NOT NULL;
