-- Organization admins appoint tournament directors for the tournaments they
-- host, so they must hold what a director holds (anti-escalation check).
-- Existing roles aren't touched by the boot-time catalog sync.
INSERT INTO "RolePermission" ("roleId", "permissionKey")
SELECT r."id", p."key"
FROM "Role" r
CROSS JOIN (VALUES ('draw.modify_locked'), ('payment.refund')) AS p("key")
WHERE r."key" IN ('CLUB_ADMIN', 'FEDERATION_ADMIN')
  AND EXISTS (SELECT 1 FROM "Permission" WHERE "key" = p."key")
ON CONFLICT DO NOTHING;
