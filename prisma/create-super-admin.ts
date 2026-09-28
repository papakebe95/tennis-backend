// Creates (or promotes) the platform's first Super Admin — the supported way
// to bootstrap production, where the development seed must never run.
//
//   SUPER_ADMIN_MSISDN=+221… SUPER_ADMIN_EMAIL=… SUPER_ADMIN_PASSWORD=… \
//   SUPER_ADMIN_FIRSTNAME=… SUPER_ADMIN_LASTNAME=… npm run admin:create
//
// An existing account with that phone number is promoted, and its password
// is left unchanged.
import 'dotenv/config';
import { PrismaClient, UserStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcrypt';
import { isStrongPassword } from 'class-validator';
import { syncAuthorizationCatalog } from '../src/authz/catalog-sync.js';
import { SUPER_ADMIN_ROLE_KEY } from '../src/authz/default-roles.js';
import { normalizePhone } from '../src/common/utils/phone.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  const env = (name: string) => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const msisdn = normalizePhone(env('SUPER_ADMIN_MSISDN'));
  if (!msisdn) throw new Error('SUPER_ADMIN_MSISDN is not a valid phone number');

  await syncAuthorizationCatalog(prisma);
  const role = await prisma.role.findUniqueOrThrow({ where: { key: SUPER_ADMIN_ROLE_KEY } });

  let user = await prisma.user.findUnique({ where: { msisdn } });
  if (!user) {
    const password = env('SUPER_ADMIN_PASSWORD');
    if (!isStrongPassword(password, { minLength: 10, minLowercase: 1, minUppercase: 1, minNumbers: 1, minSymbols: 1 })) {
      throw new Error('SUPER_ADMIN_PASSWORD must be 10+ chars with upper, lower, number and symbol');
    }
    user = await prisma.user.create({
      data: {
        msisdn,
        email: env('SUPER_ADMIN_EMAIL'),
        firstname: env('SUPER_ADMIN_FIRSTNAME'),
        lastname: env('SUPER_ADMIN_LASTNAME'),
        passwordHash: await bcrypt.hash(password, 10),
      },
    });
  }
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { status: UserStatus.ACTIVE } });
    const held = await tx.userRole.findFirst({ where: { userId: user.id, roleId: role.id, revokedAt: null } });
    if (held) return;
    const grant = await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
    await tx.auditLog.create({
      data: {
        action: 'user.roles.granted',
        entityType: 'UserRole',
        entityId: grant.id,
        after: { userId: user.id, role: SUPER_ADMIN_ROLE_KEY },
        reason: 'Bootstrapped with create-super-admin',
      },
    });
  });
  console.log(`Super Admin ready: ${msisdn}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
