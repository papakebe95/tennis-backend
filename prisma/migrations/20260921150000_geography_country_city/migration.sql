-- Country -> City -> Club -> Court.
--
-- Hand-written (Prisma's generated version drops Club.city / Club.country and
-- adds NOT NULL columns with no values, which loses data): every existing
-- club's city/country text is turned into Country/City rows first, then clubs
-- and courts are pointed at them, and only then are the old columns dropped.

-- CreateTable
CREATE TABLE "Country" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Country_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "City" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "countryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "City_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Country_code_key" ON "Country"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Country_name_key" ON "Country"("name");

-- CreateIndex
CREATE INDEX "City_countryId_idx" ON "City"("countryId");

-- CreateIndex
CREATE UNIQUE INDEX "City_countryId_name_key" ON "City"("countryId", "name");

-- AddForeignKey
ALTER TABLE "City" ADD CONSTRAINT "City_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "Country"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill countries from the clubs' free-text country. Known names get their
-- ISO code; anything else falls back to its first two letters, which is only
-- a guess — review Country.code for any country other than the ones listed.
INSERT INTO "Country" ("id", "code", "name", "updatedAt")
SELECT
  gen_random_uuid()::text,
  CASE lower(name)
    WHEN 'senegal' THEN 'SN'
    WHEN 'sénégal' THEN 'SN'
    WHEN 'france' THEN 'FR'
    WHEN 'morocco' THEN 'MA'
    WHEN 'maroc' THEN 'MA'
    WHEN 'mali' THEN 'ML'
    WHEN 'gambia' THEN 'GM'
    WHEN 'guinea' THEN 'GN'
    WHEN 'mauritania' THEN 'MR'
    ELSE upper(left(name, 2))
  END,
  name,
  CURRENT_TIMESTAMP
FROM (SELECT DISTINCT btrim("country") AS name FROM "Club") AS countries;

-- Backfill cities: one per distinct (country, city) among the clubs.
INSERT INTO "City" ("id", "name", "countryId", "updatedAt")
SELECT gen_random_uuid()::text, pairs.city, co."id", CURRENT_TIMESTAMP
FROM (SELECT DISTINCT btrim("city") AS city, btrim("country") AS country FROM "Club") AS pairs
JOIN "Country" co ON co."name" = pairs.country;

-- AlterTable: add the links as nullable, fill them, then make them required.
ALTER TABLE "Club" ADD COLUMN "cityId" TEXT;
ALTER TABLE "Court" ADD COLUMN "cityId" TEXT;

UPDATE "Club" AS club
SET "cityId" = ci."id"
FROM "City" ci
JOIN "Country" co ON co."id" = ci."countryId"
WHERE ci."name" = btrim(club."city") AND co."name" = btrim(club."country");

-- A court is in its club's city.
UPDATE "Court" AS court
SET "cityId" = club."cityId"
FROM "Club" club
WHERE club."id" = court."clubId";

ALTER TABLE "Club" ALTER COLUMN "cityId" SET NOT NULL;
ALTER TABLE "Court" ALTER COLUMN "cityId" SET NOT NULL;

-- The text columns are now redundant.
ALTER TABLE "Club" DROP COLUMN "city", DROP COLUMN "country";

-- CreateIndex
CREATE INDEX "Club_cityId_idx" ON "Club"("cityId");

-- CreateIndex: the target of Court's composite foreign key below.
CREATE UNIQUE INDEX "Club_id_cityId_key" ON "Club"("id", "cityId");

-- CreateIndex
CREATE INDEX "Court_cityId_idx" ON "Court"("cityId");

-- AddForeignKey
ALTER TABLE "Club" ADD CONSTRAINT "Club_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Replaces Court_clubId_fkey: (clubId, cityId) must match a club AND its city,
-- so a court can never be filed under a different city than its club.
ALTER TABLE "Court" DROP CONSTRAINT "Court_clubId_fkey";
ALTER TABLE "Court" ADD CONSTRAINT "Court_clubId_cityId_fkey" FOREIGN KEY ("clubId", "cityId") REFERENCES "Club"("id", "cityId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Court" ADD CONSTRAINT "Court_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
