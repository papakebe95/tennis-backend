-- AlterTable
ALTER TABLE "Club" ADD COLUMN     "bannerUrl" TEXT,
ADD COLUMN     "photos" TEXT[] DEFAULT ARRAY[]::TEXT[];
