-- CreateEnum
CREATE TYPE "PlayerSide" AS ENUM ('PLAYER1', 'PLAYER2');

-- CreateEnum
CREATE TYPE "FinalSetFormat" AS ENUM ('TIEBREAK', 'SUPER_TIEBREAK', 'ADVANTAGE');

-- AlterEnum
ALTER TYPE "MatchStatus" ADD VALUE 'UNFINISHED';

-- DropIndex
DROP INDEX "Match_player1Id_idx";

-- DropIndex
DROP INDEX "Match_player2Id_idx";

-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "bestOf" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "endedAt" TIMESTAMP(3),
ADD COLUMN     "finalSet" "FinalSetFormat" NOT NULL DEFAULT 'TIEBREAK',
ADD COLUMN     "location" TEXT,
ADD COLUMN     "noAd" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "playSeconds" INTEGER,
ADD COLUMN     "player1Points" INTEGER,
ADD COLUMN     "player2Name" TEXT,
ADD COLUMN     "player2Points" INTEGER,
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "totalSeconds" INTEGER,
ADD COLUMN     "winnerSide" "PlayerSide";

-- AlterTable
ALTER TABLE "MatchSet" ADD COLUMN     "isSuperTiebreak" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Match_player1Id_playedAt_idx" ON "Match"("player1Id", "playedAt");

-- CreateIndex
CREATE INDEX "Match_player2Id_playedAt_idx" ON "Match"("player2Id", "playedAt");
