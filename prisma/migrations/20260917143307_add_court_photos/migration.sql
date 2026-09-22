-- AlterTable
ALTER TABLE "Court" ADD COLUMN     "photos" TEXT[] DEFAULT ARRAY[]::TEXT[];
