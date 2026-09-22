-- ProductCategory: from a Postgres enum to a table Product links to.
--
-- Hand-written to keep every product: the enum is renamed out of the way (a
-- table and a type can't share the name "ProductCategory"), the seven existing
-- categories become rows, products are pointed at them by code, and only then
-- is the old column dropped.

-- The table below needs this name.
ALTER TYPE "ProductCategory" RENAME TO "ProductCategory_old";

-- CreateTable
CREATE TABLE "ProductCategory" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductCategory_code_key" ON "ProductCategory"("code");

-- The categories that existed as enum values, in the order the app lists them.
INSERT INTO "ProductCategory" ("id", "code", "label", "icon", "sortOrder", "updatedAt") VALUES
  (gen_random_uuid()::text, 'RACKET',      'Rackets',     'racket',      1, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'SHOES',       'Shoes',       'shoes',       2, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'APPAREL',     'Apparel',     'apparel',     3, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'BAGS',        'Bags',        'bags',        4, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'BALLS',       'Balls',       'balls',       5, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'ACCESSORIES', 'Accessories', 'accessories', 6, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'OTHER',       'Other',       'other',       7, CURRENT_TIMESTAMP);

-- AlterTable: add the link as nullable, fill it, then make it required.
ALTER TABLE "Product" ADD COLUMN "categoryId" TEXT;

UPDATE "Product" AS product
SET "categoryId" = pc."id"
FROM "ProductCategory" pc
WHERE pc."code" = product."category"::text;

ALTER TABLE "Product" ALTER COLUMN "categoryId" SET NOT NULL;

-- DropIndex (it covered the old column)
DROP INDEX "Product_status_category_condition_createdAt_idx";

ALTER TABLE "Product" DROP COLUMN "category";
DROP TYPE "ProductCategory_old";

-- CreateIndex
CREATE INDEX "Product_status_categoryId_condition_createdAt_idx" ON "Product"("status", "categoryId", "condition", "createdAt");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
