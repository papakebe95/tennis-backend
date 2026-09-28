-- Points four clubs at their real banner photos (uploaded to R2 under clubs/).
-- Matched on the club name; clubs that aren't there are left alone.

UPDATE "Club" SET "bannerUrl" = 'https://pub-40b3d89b0df9456088de3896732855cd.r2.dev/clubs/33b422fe-807e-4f53-b242-90db26f6cf49.jpg' WHERE "name" = 'Stade L.S.S';
UPDATE "Club" SET "bannerUrl" = 'https://pub-40b3d89b0df9456088de3896732855cd.r2.dev/clubs/015ffe3b-5257-44e6-9245-9e7efcad0e41.jpg' WHERE "name" = 'ASTU';
UPDATE "Club" SET "bannerUrl" = 'https://pub-40b3d89b0df9456088de3896732855cd.r2.dev/clubs/9c466c05-6891-48ee-81ec-bb9a22961bf5.jpg' WHERE "name" = 'Olympic Club';
UPDATE "Club" SET "bannerUrl" = 'https://pub-40b3d89b0df9456088de3896732855cd.r2.dev/clubs/d1151dc5-4aa4-4bee-b133-c538aad3b549.jpg' WHERE "name" = 'T.C.D';
