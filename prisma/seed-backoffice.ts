// Back-office seed: roles & permissions, sample organizations and one
// development account per role. DEVELOPMENT ONLY — refuses to run in
// production. Every account signs in with DEV_PASSWORD (see README).
import { OrganizationType, UserStatus, type PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import { syncAuthorizationCatalog } from '../src/authz/catalog-sync.js';

export const DEV_PASSWORD = 'Admin@2026!';

type GrantSeed =
  | { role: string }
  | { role: string; organization: string }
  | { role: string; competition: string };

interface AccountSeed {
  msisdn: string;
  email: string;
  firstname: string;
  lastname: string;
  status?: UserStatus;
  grants: GrantSeed[];
}

// Organization references: 'federation', 'community', or 'club:<index>' in
// clubs sorted by name. Competition references are competition names.
const ACCOUNTS: AccountSeed[] = [
  { msisdn: '+221770000001', email: 'superadmin@tennis.dev', firstname: 'Awa', lastname: 'Sarr', grants: [{ role: 'SUPER_ADMIN' }] },
  { msisdn: '+221770000002', email: 'federation@tennis.dev', firstname: 'Ibrahima', lastname: 'Ndiaye', grants: [{ role: 'FEDERATION_ADMIN', organization: 'federation' }] },
  {
    msisdn: '+221770000003', email: 'clubadmin@tennis.dev', firstname: 'Mamadou', lastname: 'Diop',
    // Two clubs, to exercise the context switcher.
    grants: [{ role: 'CLUB_ADMIN', organization: 'club:0' }, { role: 'CLUB_ADMIN', organization: 'club:1' }],
  },
  {
    msisdn: '+221770000004', email: 'organizer@tennis.dev', firstname: 'Khady', lastname: 'Ba',
    grants: [{ role: 'TOURNAMENT_ORGANIZER' }, { role: 'COMPETITION_ORGANIZER', competition: 'Dakar Open Amateur' }],
  },
  { msisdn: '+221770000005', email: 'director@tennis.dev', firstname: 'Fatou', lastname: 'Sow', grants: [{ role: 'TOURNAMENT_DIRECTOR', competition: 'Teranga Cup' }] },
  { msisdn: '+221770000006', email: 'official@tennis.dev', firstname: 'Amadou', lastname: 'Faye', grants: [{ role: 'OFFICIAL', competition: 'Teranga Cup' }] },
  { msisdn: '+221770000007', email: 'coach@tennis.dev', firstname: 'Ousmane', lastname: 'Gueye', grants: [{ role: 'COACH', organization: 'club:0' }] },
  { msisdn: '+221770000008', email: 'staff@tennis.dev', firstname: 'Mariama', lastname: 'Cisse', grants: [{ role: 'CLUB_STAFF', organization: 'club:2' }] },
  // Awaiting validation: signs in to the restricted "pending" area only.
  { msisdn: '+221770000009', email: 'pending@tennis.dev', firstname: 'Pape', lastname: 'Thiam', status: UserStatus.PENDING, grants: [] },
];

export async function seedBackOffice(prisma: PrismaClient) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The back-office seed creates known passwords: never run it in production');
  }

  await syncAuthorizationCatalog(prisma);

  const senegal = await prisma.country.findUnique({ where: { code: 'SN' } });
  const orgFields = { countryId: senegal?.id ?? null, status: 'ACTIVE' as const };
  const federation = await prisma.organization.upsert({
    where: { slug: 'fst' },
    update: {},
    create: {
      ...orgFields,
      type: OrganizationType.FEDERATION,
      slug: 'fst',
      name: 'Fédération Sénégalaise de Tennis',
      description: 'National governing body for tennis in Senegal (sample data).',
      email: 'contact@fst.example',
      phone: '+221338000000',
      website: 'https://fst.example',
      address: 'Dakar, Senegal',
    },
  });
  const community = await prisma.organization.upsert({
    where: { slug: 'dakar-tennis-community' },
    update: {},
    create: {
      ...orgFields,
      type: OrganizationType.COMMUNITY,
      slug: 'dakar-tennis-community',
      name: 'Dakar Tennis Community',
      description: 'Independent players organizing friendly tournaments (sample data).',
    },
  });
  const clubs = await prisma.club.findMany({ orderBy: { name: 'asc' }, select: { organizationId: true } });

  const organizationId = (ref: string): string | null => {
    if (ref === 'federation') return federation.id;
    if (ref === 'community') return community.id;
    return clubs[Number(ref.split(':')[1])]?.organizationId ?? null;
  };
  const competitionIds = new Map(
    (await prisma.competition.findMany({ select: { id: true, name: true } })).map((c) => [c.name, c.id]),
  );
  const roleIds = new Map(
    (await prisma.role.findMany({ select: { id: true, key: true } })).map((r) => [r.key, r.id]),
  );

  const passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);
  let superAdminId: string | null = null;
  let grantCount = 0;

  for (const { grants, status = UserStatus.ACTIVE, ...account } of ACCOUNTS) {
    const user = await prisma.user.upsert({
      where: { msisdn: account.msisdn },
      update: { ...account, status, passwordHash, passwordChangedAt: null, mustChangePassword: false },
      create: { ...account, status, passwordHash },
    });
    superAdminId ??= user.id;

    // Idempotent: the seeded account's grants are exactly the list above.
    // Audit rows are only written the first time.
    const firstRun = (await prisma.userRole.count({ where: { userId: user.id } })) === 0;
    await prisma.userRole.deleteMany({ where: { userId: user.id } });
    for (const grant of grants) {
      const roleId = roleIds.get(grant.role);
      if (!roleId) throw new Error(`Unknown role ${grant.role}`);
      const scope =
        'organization' in grant
          ? { organizationId: organizationId(grant.organization) }
          : 'competition' in grant
            ? { competitionId: competitionIds.get(grant.competition) ?? null }
            : {};
      if (Object.values(scope).some((id) => id === null)) {
        console.warn(`Skipped ${grant.role} for ${account.email}: scope not found`);
        continue;
      }
      const row = await prisma.userRole.create({
        data: { userId: user.id, roleId, grantedById: superAdminId, ...scope },
      });
      grantCount++;
      if (firstRun) {
        await prisma.auditLog.create({
          data: {
            actorId: superAdminId,
            action: 'user.roles.granted',
            entityType: 'UserRole',
            entityId: row.id,
            organizationId: 'organizationId' in scope ? scope.organizationId : null,
            competitionId: 'competitionId' in scope ? scope.competitionId : null,
            after: { userId: user.id, role: grant.role, ...scope },
          },
        });
      }
    }
  }

  // Federation affiliations: two clubs affiliated, one waiting for validation.
  const clubOrgs = clubs.map((c) => c.organizationId);
  const affiliations: [string | undefined, 'ACTIVE' | 'PENDING'][] = [
    [clubOrgs[0], 'ACTIVE'],
    [clubOrgs[1], 'ACTIVE'],
    [clubOrgs[2], 'PENDING'],
  ];
  for (const [memberOrgId, status] of affiliations) {
    if (!memberOrgId) continue;
    const data = { status, validatedAt: status === 'ACTIVE' ? new Date() : null, validatedById: status === 'ACTIVE' ? superAdminId : null, endedAt: null };
    await prisma.organizationAffiliation.upsert({
      where: { memberOrgId_parentOrgId: { memberOrgId, parentOrgId: federation.id } },
      update: data,
      create: { ...data, memberOrgId, parentOrgId: federation.id, requestedById: superAdminId },
    });
  }

  // Courts in every state: one under maintenance, one disabled, and a
  // floodlit court open evenings only (its own availability overrides the
  // club's hours).
  const courtsOf = (orgId?: string) =>
    orgId ? prisma.court.findMany({ where: { club: { organizationId: orgId } }, orderBy: { number: 'asc' } }) : Promise.resolve([]);
  const [first, second, third] = await Promise.all([courtsOf(clubOrgs[0]), courtsOf(clubOrgs[1]), courtsOf(clubOrgs[2])]);
  await prisma.court.updateMany({ where: { id: { in: [...first, ...second, ...third].map((c) => c.id) } }, data: { status: 'AVAILABLE', archivedAt: null } });
  if (second[0]) await prisma.court.update({ where: { id: second[0].id }, data: { status: 'MAINTENANCE' } });
  if (third[1]) await prisma.court.update({ where: { id: third[1].id }, data: { status: 'DISABLED' } });
  if (first[0]) {
    await prisma.court.update({ where: { id: first[0].id }, data: { lighting: true } });
    await prisma.courtAvailability.deleteMany({ where: { courtId: first[0].id } });
    await prisma.courtAvailability.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ courtId: first[0].id, weekday, opensAt: '17:00', closesAt: '23:00' })),
    });
  }

  // Access requests, so the review screens have something to show. Rebuilt on
  // every run for the seeded applicants.
  const firstCity = await prisma.city.findFirst({ orderBy: { name: 'asc' } });
  const pending = await prisma.user.findUniqueOrThrow({ where: { msisdn: '+221770000009' } });
  const player = await prisma.user.findUnique({ where: { email: 'moussa.diallo@example.com' } });
  const applicantIds = [pending.id, ...(player ? [player.id] : [])];
  await prisma.accessRequest.deleteMany({ where: { userId: { in: applicantIds } } });
  const DAY_MS = 24 * 60 * 60 * 1000;
  await prisma.accessRequest.create({
    data: {
      userId: pending.id,
      roleId: roleIds.get('CLUB_ADMIN')!,
      proposedOrganization: {
        type: 'CLUB',
        name: 'Tennis Club de Saly',
        cityId: firstCity?.id,
        countryId: firstCity?.countryId,
        address: 'Route de Saly Portudal',
        phone: '+221339570000',
      },
      message: 'Je gère le club de Saly (4 courts en terre battue) et souhaite y organiser les réservations et tournois.',
      createdAt: new Date(Date.now() - 2 * DAY_MS),
    },
  });
  if (player) {
    await prisma.accessRequest.create({
      data: {
        userId: player.id,
        roleId: roleIds.get('TOURNAMENT_ORGANIZER')!,
        status: 'INFO_REQUESTED',
        message: 'I run a monthly amateur tournament at Almadies with friends.',
        infoRequest: 'How many players usually take part, and on which courts?',
        reviewerId: superAdminId,
        createdAt: new Date(Date.now() - 5 * DAY_MS),
      },
    });
    await prisma.accessRequest.create({
      data: {
        userId: player.id,
        roleId: roleIds.get('FEDERATION_ADMIN')!,
        organizationId: federation.id,
        status: 'REJECTED',
        message: 'I would like to help the federation.',
        decisionReason: 'Federation administrators are appointed by the federation board.',
        reviewerId: superAdminId,
        reviewedAt: new Date(Date.now() - 9 * DAY_MS),
        createdAt: new Date(Date.now() - 10 * DAY_MS),
      },
    });
  }

  console.log(
    `Seeded back-office: ${ACCOUNTS.length} dev accounts (password "${DEV_PASSWORD}"), ${grantCount} grants, federation + community`,
  );
}
