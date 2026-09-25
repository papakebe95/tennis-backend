-- AlterTable
ALTER TABLE "City" ADD COLUMN     "translations" JSONB;

-- AlterTable
ALTER TABLE "Club" ADD COLUMN     "translations" JSONB;

-- AlterTable
ALTER TABLE "Competition" ADD COLUMN     "translations" JSONB;

-- AlterTable
ALTER TABLE "Country" ADD COLUMN     "translations" JSONB;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "messageKey" TEXT,
ADD COLUMN     "params" JSONB;

-- AlterTable
ALTER TABLE "ProductCategory" ADD COLUMN     "translations" JSONB;

-- AlterTable
ALTER TABLE "Story" ADD COLUMN     "translations" JSONB;

