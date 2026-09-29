-- CreateEnum
CREATE TYPE "CompetitionVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "EventDiscipline" AS ENUM ('SINGLES', 'DOUBLES');

-- CreateEnum
CREATE TYPE "EventGender" AS ENUM ('MEN', 'WOMEN', 'MIXED', 'OPEN');

-- CreateEnum
CREATE TYPE "DrawStatus" AS ENUM ('NOT_GENERATED', 'DRAFT', 'PUBLISHED', 'LOCKED');

-- CreateEnum
CREATE TYPE "RegistrationStatus" AS ENUM ('PENDING', 'APPROVED', 'WAITLISTED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "EntryType" AS ENUM ('DIRECT', 'QUALIFIER', 'LUCKY_LOSER', 'ALTERNATE', 'WILDCARD');

-- CreateEnum
CREATE TYPE "InterruptionReason" AS ENUM ('WEATHER', 'COURT_ISSUE', 'ORGANIZATIONAL', 'EMERGENCY', 'OTHER');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE');

-- AlterEnum: explicit lifecycle. The old status was only trusted for
-- COMPLETED; dates decided the rest, so map from both.
CREATE TYPE "CompetitionStatus_new" AS ENUM ('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'IN_PROGRESS', 'INTERRUPTED', 'COMPLETED', 'CANCELLED');
ALTER TABLE "Competition" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Competition" ALTER COLUMN "status" TYPE "CompetitionStatus_new" USING (
  CASE
    WHEN "status"::text = 'COMPLETED' OR "endDate" < now() THEN 'COMPLETED'
    WHEN "startDate" <= now() THEN 'IN_PROGRESS'
    ELSE 'REGISTRATION_OPEN'
  END::"CompetitionStatus_new"
);
ALTER TYPE "CompetitionStatus" RENAME TO "CompetitionStatus_old";
ALTER TYPE "CompetitionStatus_new" RENAME TO "CompetitionStatus";
DROP TYPE "CompetitionStatus_old";
ALTER TABLE "Competition" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

-- DropIndex
DROP INDEX "CompetitionParticipant_competitionId_userId_key";

-- AlterTable
ALTER TABLE "Competition" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'XOF',
ADD COLUMN     "hostOrganizationId" TEXT,
ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "registrationClosesAt" TIMESTAMP(3),
ADD COLUMN     "registrationOpensAt" TIMESTAMP(3),
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Africa/Dakar',
ADD COLUMN     "visibility" "CompetitionVisibility" NOT NULL DEFAULT 'PUBLIC';

-- Existing tournaments were published and hosted by their venue club.
UPDATE "Competition" c SET "publishedAt" = c."createdAt",
  "hostOrganizationId" = (SELECT "organizationId" FROM "Club" WHERE "id" = c."clubId")
WHERE c."status" <> 'DRAFT';

-- AlterTable
ALTER TABLE "CompetitionParticipant" ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "decidedById" TEXT,
ADD COLUMN     "eligibility" JSONB,
ADD COLUMN     "entryType" "EntryType" NOT NULL DEFAULT 'DIRECT',
ADD COLUMN     "eventId" TEXT,
ADD COLUMN     "partnerUserId" TEXT,
ADD COLUMN     "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "sourceEventId" TEXT,
ADD COLUMN     "status" "RegistrationStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "PlayerProfile" ADD COLUMN     "birthDate" DATE,
ADD COLUMN     "classificationId" TEXT,
ADD COLUMN     "gender" "Gender";

-- CreateTable
CREATE TABLE "Classification" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "series" TEXT NOT NULL,

    CONSTRAINT "Classification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitionEvent" (
    "id" TEXT NOT NULL,
    "competitionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "discipline" "EventDiscipline" NOT NULL DEFAULT 'SINGLES',
    "gender" "EventGender" NOT NULL DEFAULT 'OPEN',
    "ageMin" INTEGER,
    "ageMax" INTEGER,
    "minClassificationId" TEXT,
    "maxClassificationId" TEXT,
    "format" "CompetitionFormat" NOT NULL DEFAULT 'SINGLE_ELIMINATION',
    "maxEntries" INTEGER,
    "entryFee" DECIMAL(12,2),
    "seedCount" INTEGER NOT NULL DEFAULT 0,
    "bestOf" INTEGER NOT NULL DEFAULT 3,
    "gamesPerSet" INTEGER NOT NULL DEFAULT 6,
    "finalSet" "FinalSetFormat" NOT NULL DEFAULT 'TIEBREAK',
    "noAd" BOOLEAN NOT NULL DEFAULT false,
    "matchDurationMinutes" INTEGER NOT NULL DEFAULT 90,
    "qualifiesIntoEventId" TEXT,
    "qualifierCount" INTEGER NOT NULL DEFAULT 0,
    "tableOrder" INTEGER NOT NULL DEFAULT 0,
    "drawStatus" "DrawStatus" NOT NULL DEFAULT 'NOT_GENERATED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompetitionEvent_pkey" PRIMARY KEY ("id")
);

-- One default event per existing tournament, built from its own fields;
-- existing registrations become approved entries of it.
INSERT INTO "CompetitionEvent" ("id", "competitionId", "name", "format", "maxEntries", "entryFee", "updatedAt")
SELECT 'evt_' || c."id", c."id", COALESCE(NULLIF(c."category", ''), 'Simple'), c."format", c."maxParticipants", c."entryFee", now()
FROM "Competition" c;
UPDATE "CompetitionParticipant" SET "eventId" = 'evt_' || "competitionId", "status" = 'APPROVED';
ALTER TABLE "CompetitionParticipant" ALTER COLUMN "eventId" SET NOT NULL;

-- CreateTable
CREATE TABLE "CompetitionInterruption" (
    "id" TEXT NOT NULL,
    "competitionId" TEXT NOT NULL,
    "reason" "InterruptionReason" NOT NULL,
    "note" TEXT,
    "previousStatus" "CompetitionStatus" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedById" TEXT,
    "resumedAt" TIMESTAMP(3),
    "resumedById" TEXT,
    "participantsNotified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CompetitionInterruption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Classification_code_key" ON "Classification"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Classification_rank_key" ON "Classification"("rank");

-- CreateIndex
CREATE INDEX "CompetitionEvent_competitionId_tableOrder_idx" ON "CompetitionEvent"("competitionId", "tableOrder");

-- CreateIndex
CREATE INDEX "CompetitionInterruption_competitionId_startedAt_idx" ON "CompetitionInterruption"("competitionId", "startedAt");

-- CreateIndex
CREATE INDEX "Competition_hostOrganizationId_idx" ON "Competition"("hostOrganizationId");

-- CreateIndex
CREATE INDEX "Competition_status_startDate_idx" ON "Competition"("status", "startDate");

-- CreateIndex
CREATE INDEX "CompetitionParticipant_competitionId_userId_idx" ON "CompetitionParticipant"("competitionId", "userId");

-- CreateIndex
CREATE INDEX "CompetitionParticipant_eventId_status_idx" ON "CompetitionParticipant"("eventId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitionParticipant_eventId_userId_key" ON "CompetitionParticipant"("eventId", "userId");

-- AddForeignKey
ALTER TABLE "PlayerProfile" ADD CONSTRAINT "PlayerProfile_classificationId_fkey" FOREIGN KEY ("classificationId") REFERENCES "Classification"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Competition" ADD CONSTRAINT "Competition_hostOrganizationId_fkey" FOREIGN KEY ("hostOrganizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Competition" ADD CONSTRAINT "Competition_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionEvent" ADD CONSTRAINT "CompetitionEvent_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "Competition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionEvent" ADD CONSTRAINT "CompetitionEvent_minClassificationId_fkey" FOREIGN KEY ("minClassificationId") REFERENCES "Classification"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionEvent" ADD CONSTRAINT "CompetitionEvent_maxClassificationId_fkey" FOREIGN KEY ("maxClassificationId") REFERENCES "Classification"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionEvent" ADD CONSTRAINT "CompetitionEvent_qualifiesIntoEventId_fkey" FOREIGN KEY ("qualifiesIntoEventId") REFERENCES "CompetitionEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionInterruption" ADD CONSTRAINT "CompetitionInterruption_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "Competition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionInterruption" ADD CONSTRAINT "CompetitionInterruption_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionInterruption" ADD CONSTRAINT "CompetitionInterruption_resumedById_fkey" FOREIGN KEY ("resumedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionParticipant" ADD CONSTRAINT "CompetitionParticipant_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "CompetitionEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionParticipant" ADD CONSTRAINT "CompetitionParticipant_sourceEventId_fkey" FOREIGN KEY ("sourceEventId") REFERENCES "CompetitionEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionParticipant" ADD CONSTRAINT "CompetitionParticipant_partnerUserId_fkey" FOREIGN KEY ("partnerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionParticipant" ADD CONSTRAINT "CompetitionParticipant_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Sanity rules the API also enforces.
ALTER TABLE "CompetitionEvent" ADD CONSTRAINT "CompetitionEvent_rules_check" CHECK (
  "bestOf" IN (1, 3, 5) AND "gamesPerSet" BETWEEN 1 AND 9 AND "qualifierCount" >= 0
  AND "seedCount" >= 0 AND ("maxEntries" IS NULL OR "maxEntries" >= 2)
  AND ("entryFee" IS NULL OR "entryFee" >= 0)
  AND ("ageMin" IS NULL OR "ageMax" IS NULL OR "ageMin" <= "ageMax")
  AND "matchDurationMinutes" BETWEEN 15 AND 600
  AND ("qualifiesIntoEventId" IS NULL OR "qualifiesIntoEventId" <> "id")
);
ALTER TABLE "CompetitionParticipant" ADD CONSTRAINT "CompetitionParticipant_partner_check" CHECK ("partnerUserId" IS NULL OR "partnerUserId" <> "userId");

-- National classification scale (reference data), strongest first.
INSERT INTO "Classification" ("id", "code", "label", "rank", "series") VALUES
  ('cls_m30', '-30', '-30', 1, 'S2'),
  ('cls_m15', '-15', '-15', 2, 'S2'),
  ('cls_m4_6', '-4/6', '-4/6', 3, 'S2'),
  ('cls_m2_6', '-2/6', '-2/6', 4, 'S2'),
  ('cls_0', '0', '0', 5, 'S2'),
  ('cls_1_6', '1/6', '1/6', 6, 'S3'),
  ('cls_2_6', '2/6', '2/6', 7, 'S3'),
  ('cls_3_6', '3/6', '3/6', 8, 'S3'),
  ('cls_4_6', '4/6', '4/6', 9, 'S3'),
  ('cls_5_6', '5/6', '5/6', 10, 'S3'),
  ('cls_15', '15', '15', 11, 'S3'),
  ('cls_15_1', '15/1', '15/1', 12, 'S4'),
  ('cls_15_2', '15/2', '15/2', 13, 'S4'),
  ('cls_15_3', '15/3', '15/3', 14, 'S4'),
  ('cls_15_4', '15/4', '15/4', 15, 'S4'),
  ('cls_15_5', '15/5', '15/5', 16, 'S4'),
  ('cls_30', '30', '30', 17, 'S4'),
  ('cls_30_1', '30/1', '30/1', 18, 'S4'),
  ('cls_30_2', '30/2', '30/2', 19, 'S4'),
  ('cls_30_3', '30/3', '30/3', 20, 'S4'),
  ('cls_30_4', '30/4', '30/4', 21, 'S4'),
  ('cls_30_5', '30/5', '30/5', 22, 'S4'),
  ('cls_40', '40', '40', 23, 'S4'),
  ('cls_nc', 'NC', 'Non classé', 24, 'NC');

-- New permission, and give it to the existing Federation Admin role (roles
-- that already exist aren't touched by the boot-time sync).
INSERT INTO "Permission" ("key", "module", "description", "scopes")
VALUES ('player.sport_profile.manage', 'organization', 'Set players'' classification, gender and birth date', ARRAY['GLOBAL', 'ORGANIZATION']::"RoleScope"[])
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "RolePermission" ("roleId", "permissionKey")
SELECT "id", 'player.sport_profile.manage' FROM "Role" WHERE "key" = 'FEDERATION_ADMIN'
ON CONFLICT DO NOTHING;
