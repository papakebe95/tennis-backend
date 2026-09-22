-- CreateEnum
CREATE TYPE "AvailabilityStatus" AS ENUM ('AVAILABLE', 'LOOKING_FOR_MATCH', 'BUSY', 'INJURED', 'ON_VACATION', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "DominantHand" AS ENUM ('RIGHT', 'LEFT');

-- CreateEnum
CREATE TYPE "Backhand" AS ENUM ('ONE_HANDED', 'TWO_HANDED');

-- CreateEnum
CREATE TYPE "PhoneLabel" AS ENUM ('MOBILE', 'WHATSAPP', 'WORK', 'HOME', 'OTHER');

-- AlterTable
ALTER TABLE "PlayerProfile" ADD COLUMN     "availabilityNote" TEXT,
ADD COLUMN     "availabilityStatus" "AvailabilityStatus" NOT NULL DEFAULT 'AVAILABLE',
ADD COLUMN     "backhand" "Backhand",
ADD COLUMN     "city" TEXT,
ADD COLUMN     "dominantHand" "DominantHand";

-- CreateTable
CREATE TABLE "UserPhone" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "label" "PhoneLabel" NOT NULL DEFAULT 'MOBILE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserPhone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserPhone_number_key" ON "UserPhone"("number");

-- CreateIndex
CREATE INDEX "UserPhone_userId_idx" ON "UserPhone"("userId");

-- AddForeignKey
ALTER TABLE "UserPhone" ADD CONSTRAINT "UserPhone_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
