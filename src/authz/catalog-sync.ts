import type { PrismaClient } from '@prisma/client';
import { DEFAULT_ROLES } from './default-roles.js';
import { PERMISSIONS } from './permissions.js';

/**
 * Makes the Permission table match the code catalog and creates the default
 * roles that don't exist yet. System roles get their permissions reset from
 * code; other roles are left as the Super Admin edited them. Idempotent: run
 * at every boot and by the seed.
 */
export async function syncAuthorizationCatalog(prisma: PrismaClient) {
  const keys = Object.keys(PERMISSIONS);
  for (const [key, { module, description, scopes }] of Object.entries(PERMISSIONS)) {
    const data = { module, description, scopes: [...scopes] };
    await prisma.permission.upsert({
      where: { key },
      update: data,
      create: { key, ...data },
    });
  }
  // A permission removed from code must stop granting anything.
  await prisma.permission.deleteMany({ where: { key: { notIn: keys } } });

  for (const role of DEFAULT_ROLES) {
    const { permissions, ...fields } = role;
    const existing = await prisma.role.findUnique({ where: { key: role.key } });
    if (existing && !role.isSystem) {
      // Fill in fields added after the role was created; never overwrite
      // what the Super Admin edited.
      if (existing.organizationType === null && fields.organizationType) {
        await prisma.role.update({
          where: { id: existing.id },
          data: { organizationType: fields.organizationType },
        });
      }
      continue;
    }

    await prisma.$transaction(async (tx) => {
      const saved = existing
        ? await tx.role.update({ where: { id: existing.id }, data: fields })
        : await tx.role.create({ data: fields });
      await tx.rolePermission.deleteMany({ where: { roleId: saved.id } });
      await tx.rolePermission.createMany({
        data: [...new Set(permissions)].map((permissionKey) => ({
          roleId: saved.id,
          permissionKey,
        })),
      });
    });
  }
}
