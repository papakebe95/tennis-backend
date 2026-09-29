-- CreateEnum
CREATE TYPE "DrawSlotKind" AS ENUM ('ENTRY', 'BYE', 'QUALIFIER', 'EMPTY');

-- DropIndex
DROP INDEX "CompetitionMatch_roundId_idx";

-- AlterTable
ALTER TABLE "CompetitionEvent" ADD COLUMN     "drawGeneratedAt" TIMESTAMP(3),
ADD COLUMN     "drawLockedAt" TIMESTAMP(3),
ADD COLUMN     "drawPublishedAt" TIMESTAMP(3),
ADD COLUMN     "drawSeed" TEXT,
ADD COLUMN     "drawSize" INTEGER,
ADD COLUMN     "drawVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "CompetitionMatch" ADD COLUMN     "nextSlot" INTEGER,
ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "CompetitionRound" ADD COLUMN     "eventId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "DrawSlot" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" "DrawSlotKind" NOT NULL,
    "participantId" TEXT,
    "label" TEXT,
    "sourceEventId" TEXT,
    "filledAt" TIMESTAMP(3),
    "filledById" TEXT,

    CONSTRAINT "DrawSlot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DrawSlot_participantId_key" ON "DrawSlot"("participantId");

-- CreateIndex
CREATE UNIQUE INDEX "DrawSlot_eventId_position_key" ON "DrawSlot"("eventId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitionMatch_roundId_position_key" ON "CompetitionMatch"("roundId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitionRound_eventId_orderIndex_key" ON "CompetitionRound"("eventId", "orderIndex");

-- AddForeignKey
ALTER TABLE "CompetitionRound" ADD CONSTRAINT "CompetitionRound_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "CompetitionEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DrawSlot" ADD CONSTRAINT "DrawSlot_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "CompetitionEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DrawSlot" ADD CONSTRAINT "DrawSlot_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "CompetitionParticipant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DrawSlot" ADD CONSTRAINT "DrawSlot_sourceEventId_fkey" FOREIGN KEY ("sourceEventId") REFERENCES "CompetitionEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A draw place holds a participant exactly when it is an ENTRY; draw sizes
-- are powers of two up to 128.
ALTER TABLE "DrawSlot" ADD CONSTRAINT "DrawSlot_kind_check" CHECK (("kind" = 'ENTRY') = ("participantId" IS NOT NULL));
ALTER TABLE "DrawSlot" ADD CONSTRAINT "DrawSlot_position_check" CHECK ("position" >= 0);
ALTER TABLE "CompetitionEvent" ADD CONSTRAINT "CompetitionEvent_drawSize_check" CHECK ("drawSize" IS NULL OR "drawSize" IN (2, 4, 8, 16, 32, 64, 128));
ALTER TABLE "CompetitionMatch" ADD CONSTRAINT "CompetitionMatch_nextSlot_check" CHECK ("nextSlot" IS NULL OR "nextSlot" IN (1, 2));
