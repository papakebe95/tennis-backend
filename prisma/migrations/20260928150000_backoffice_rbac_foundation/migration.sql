-- The old `Role` enum is superseded by the Role table; rename it out of the
-- way (its values are migrated to UserRole below, then it is dropped).
ALTER TYPE "Role" RENAME TO "LegacyRole";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'DISABLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RoleScope" AS ENUM ('GLOBAL', 'ORGANIZATION', 'COMPETITION');

-- CreateEnum
CREATE TYPE "OrganizationType" AS ENUM ('FEDERATION', 'CLUB', 'COMMUNITY');

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "passwordChangedAt" TIMESTAMP(3),
ADD COLUMN     "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "type" "OrganizationType" NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
    "logoUrl" TEXT,
    "description" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "socialLinks" JSONB,
    "countryId" TEXT,
    "address" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "key" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "scopes" "RoleScope"[],

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scope" "RoleScope" NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "selfRegistrable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "roleId" TEXT NOT NULL,
    "permissionKey" TEXT NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId","permissionKey")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "organizationId" TEXT,
    "competitionId" TEXT,
    "grantedById" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "organizationId" TEXT,
    "competitionId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- Every existing club becomes an Organization of type CLUB (same contact
-- data), linked 1:1 through Club.organizationId.
ALTER TABLE "Club" ADD COLUMN "organizationId" TEXT;

INSERT INTO "Organization" ("id", "type", "name", "slug", "status", "logoUrl", "description", "email", "phone", "countryId", "address", "createdAt", "updatedAt")
SELECT 'org_' || c."id", 'CLUB', c."name", 'club-' || c."id", 'ACTIVE', c."logoUrl", c."description", c."email", c."phone", ci."countryId", c."address", c."createdAt", CURRENT_TIMESTAMP
FROM "Club" c JOIN "City" ci ON ci."id" = c."cityId";

UPDATE "Club" SET "organizationId" = 'org_' || "id";

ALTER TABLE "Club" ALTER COLUMN "organizationId" SET NOT NULL;

-- The old `User.role = ADMIN` becomes a SUPER_ADMIN grant. The role row is
-- created here so the grant can reference it; its permissions are synced
-- from code at boot (src/authz/catalog-sync.ts).
INSERT INTO "Role" ("id", "key", "name", "description", "scope", "isSystem", "updatedAt")
VALUES ('role_super_admin', 'SUPER_ADMIN', 'Super Admin', 'Full access to the platform.', 'GLOBAL', true, CURRENT_TIMESTAMP);

INSERT INTO "UserRole" ("id", "userId", "roleId")
SELECT 'ur_' || u."id", u."id", 'role_super_admin' FROM "User" u WHERE u."role" = 'ADMIN';

ALTER TABLE "User" DROP COLUMN "role";

-- DropEnum
DROP TYPE "LegacyRole";

-- A grant sits on at most one organization or competition.
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_single_scope_check"
  CHECK ("organizationId" IS NULL OR "competitionId" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "Organization_type_status_idx" ON "Organization"("type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Role_key_key" ON "Role"("key");

-- CreateIndex
CREATE INDEX "RolePermission_permissionKey_idx" ON "RolePermission"("permissionKey");

-- CreateIndex
CREATE INDEX "UserRole_userId_revokedAt_idx" ON "UserRole"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "UserRole_organizationId_idx" ON "UserRole"("organizationId");

-- CreateIndex
CREATE INDEX "UserRole_competitionId_idx" ON "UserRole"("competitionId");

-- CreateIndex
CREATE INDEX "UserRole_roleId_idx" ON "UserRole"("roleId");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "AuditLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_competitionId_createdAt_idx" ON "AuditLog"("competitionId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Club_organizationId_key" ON "Club"("organizationId");

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "Country"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionKey_fkey" FOREIGN KEY ("permissionKey") REFERENCES "Permission"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "Competition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "Competition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Club" ADD CONSTRAINT "Club_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

