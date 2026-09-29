-- CreateEnum
CREATE TYPE "MatchOutcome" AS ENUM ('PLAYED', 'RETIRED', 'WALKOVER');

-- CreateEnum
CREATE TYPE "ResultStatus" AS ENUM ('NONE', 'ENTERED', 'VALIDATED', 'DISPUTED');


-- AlterTable
ALTER TABLE "CompetitionMatch" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "disputeReason" TEXT,
ADD COLUMN     "loserSide" INTEGER,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "officialUserId" TEXT,
ADD COLUMN     "outcome" "MatchOutcome",
ADD COLUMN     "resultEnteredAt" TIMESTAMP(3),
ADD COLUMN     "resultEnteredById" TEXT,
ADD COLUMN     "resultStatus" "ResultStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "resultValidatedAt" TIMESTAMP(3),
ADD COLUMN     "resultValidatedById" TEXT,
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "CompetitionMatchSet" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "setNumber" INTEGER NOT NULL,
    "side1Games" INTEGER NOT NULL,
    "side2Games" INTEGER NOT NULL,
    "tiebreak1" INTEGER,
    "tiebreak2" INTEGER,
    "isSuperTiebreak" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CompetitionMatchSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitionCourt" (
    "competitionId" TEXT NOT NULL,
    "courtId" TEXT NOT NULL,

    CONSTRAINT "CompetitionCourt_pkey" PRIMARY KEY ("competitionId","courtId")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompetitionMatchSet_matchId_setNumber_key" ON "CompetitionMatchSet"("matchId", "setNumber");

-- AddForeignKey
ALTER TABLE "CompetitionMatch" ADD CONSTRAINT "CompetitionMatch_officialUserId_fkey" FOREIGN KEY ("officialUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionMatchSet" ADD CONSTRAINT "CompetitionMatchSet_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "CompetitionMatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionCourt" ADD CONSTRAINT "CompetitionCourt_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "Competition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionCourt" ADD CONSTRAINT "CompetitionCourt_courtId_fkey" FOREIGN KEY ("courtId") REFERENCES "Court"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Scores and results the API also validates.
ALTER TABLE "CompetitionMatchSet" ADD CONSTRAINT "CompetitionMatchSet_games_check" CHECK (
  "setNumber" BETWEEN 1 AND 5 AND "side1Games" BETWEEN 0 AND 99 AND "side2Games" BETWEEN 0 AND 99
  AND ("tiebreak1" IS NULL OR "tiebreak1" >= 0) AND ("tiebreak2" IS NULL OR "tiebreak2" >= 0)
);
ALTER TABLE "CompetitionMatch" ADD CONSTRAINT "CompetitionMatch_loserSide_check" CHECK ("loserSide" IS NULL OR "loserSide" IN (1, 2));
CREATE INDEX "CompetitionMatch_scheduledAt_idx" ON "CompetitionMatch"("scheduledAt");
CREATE INDEX "CompetitionMatch_officialUserId_idx" ON "CompetitionMatch"("officialUserId");
