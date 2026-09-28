-- CreateEnum
CREATE TYPE "AffiliationStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'ENDED');

-- CreateEnum
CREATE TYPE "CourtStatus" AS ENUM ('AVAILABLE', 'MAINTENANCE', 'DISABLED');

-- DropForeignKey
ALTER TABLE "Booking" DROP CONSTRAINT "Booking_courtId_fkey";

-- AlterTable
ALTER TABLE "Court" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "lighting" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "number" INTEGER,
ADD COLUMN     "status" "CourtStatus" NOT NULL DEFAULT 'AVAILABLE';

-- CreateTable
CREATE TABLE "CourtAvailability" (
    "id" TEXT NOT NULL,
    "courtId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "opensAt" TEXT NOT NULL,
    "closesAt" TEXT NOT NULL,

    CONSTRAINT "CourtAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationAffiliation" (
    "id" TEXT NOT NULL,
    "memberOrgId" TEXT NOT NULL,
    "parentOrgId" TEXT NOT NULL,
    "status" "AffiliationStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestedById" TEXT,
    "validatedAt" TIMESTAMP(3),
    "validatedById" TEXT,
    "endedAt" TIMESTAMP(3),
    "reason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationAffiliation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CourtAvailability_courtId_weekday_idx" ON "CourtAvailability"("courtId", "weekday");

-- CreateIndex
CREATE INDEX "OrganizationAffiliation_parentOrgId_status_idx" ON "OrganizationAffiliation"("parentOrgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationAffiliation_memberOrgId_parentOrgId_key" ON "OrganizationAffiliation"("memberOrgId", "parentOrgId");

-- AddForeignKey
ALTER TABLE "CourtAvailability" ADD CONSTRAINT "CourtAvailability_courtId_fkey" FOREIGN KEY ("courtId") REFERENCES "Court"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationAffiliation" ADD CONSTRAINT "OrganizationAffiliation_memberOrgId_fkey" FOREIGN KEY ("memberOrgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationAffiliation" ADD CONSTRAINT "OrganizationAffiliation_parentOrgId_fkey" FOREIGN KEY ("parentOrgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_courtId_fkey" FOREIGN KEY ("courtId") REFERENCES "Court"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Number existing courts 1..n within their club, by name.
UPDATE "Court" c SET "number" = n.rn
FROM (SELECT "id", ROW_NUMBER() OVER (PARTITION BY "clubId" ORDER BY "name") AS rn FROM "Court") n
WHERE c."id" = n."id";
