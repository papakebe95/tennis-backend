-- CreateEnum
CREATE TYPE "MembershipRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ClubMembershipRequest" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT,
    "message" TEXT,
    "status" "MembershipRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "reason" TEXT,
    "memberId" TEXT,

    CONSTRAINT "ClubMembershipRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClubMembershipRequest_clubId_status_createdAt_idx" ON "ClubMembershipRequest"("clubId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ClubMembershipRequest_userId_status_idx" ON "ClubMembershipRequest"("userId", "status");

-- AddForeignKey
ALTER TABLE "ClubMembershipRequest" ADD CONSTRAINT "ClubMembershipRequest_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubMembershipRequest" ADD CONSTRAINT "ClubMembershipRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubMembershipRequest" ADD CONSTRAINT "ClubMembershipRequest_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MembershipPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubMembershipRequest" ADD CONSTRAINT "ClubMembershipRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- At most one pending request per player and club.
CREATE UNIQUE INDEX "ClubMembershipRequest_one_pending" ON "ClubMembershipRequest"("clubId", "userId") WHERE "status" = 'PENDING';
