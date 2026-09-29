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

  await seedMembership(prisma, clubs.slice(0, 2).map((c) => c.organizationId), superAdminId);
  await seedTournaments(prisma, clubs[0]?.organizationId ?? null, federation.id);

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

// ---------------------------------------------------------------------------
// Members, plans, payments and bookings for the first two clubs, covering
// every membership payment state. Only the sample players below are touched.
// ---------------------------------------------------------------------------

const SAMPLE_PLAYERS = [
  ['Seynabou', 'Diagne', 'INTERMEDIATE'],
  ['Babacar', 'Sy', 'ADVANCED'],
  ['Ndeye', 'Mbaye', 'BEGINNER'],
  ['Ousmane', 'Sarr', 'INTERMEDIATE'],
  ['Khadija', 'Toure', 'ADVANCED'],
  ['Lamine', 'Gaye', 'BEGINNER'],
  ['Adama', 'Cisse', 'INTERMEDIATE'],
  ['Rokhaya', 'Fall', 'EXPERT'],
  ['Ibou', 'Ndour', 'INTERMEDIATE'],
  ['Mame', 'Diouf', 'BEGINNER'],
] as const;

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => {
  const d = new Date(Date.now() - n * DAY);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};
const addMonthsUtc = (date: Date, months: number) => {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
};
const reference = (i: number) => `PAY-SEED-${String(i).padStart(4, '0')}`;

async function seedMembership(prisma: PrismaClient, clubOrgIds: string[], recorderId: string | null) {
  const passwordHash = await bcrypt.hash('password123', 10);
  const players = [];
  for (const [index, [firstname, lastname, level]] of SAMPLE_PLAYERS.entries()) {
    const msisdn = `+2217700002${String(index).padStart(2, '0')}`;
    const email = `${firstname}.${lastname}@members.example`.toLowerCase();
    const user = await prisma.user.upsert({
      where: { msisdn },
      update: { firstname, lastname, email },
      create: { msisdn, email, firstname, lastname, passwordHash },
    });
    await prisma.playerProfile.upsert({
      where: { userId: user.id },
      update: { level },
      create: { userId: user.id, level, city: 'Dakar' },
    });
    players.push(user);
  }
  const playerIds = players.map((p) => p.id);

  // Reset what the previous run created for these players.
  await prisma.payment.deleteMany({ where: { payerId: { in: playerIds } } });
  await prisma.payment.deleteMany({ where: { reference: { startsWith: 'PAY-SEED-' } } });
  await prisma.booking.deleteMany({ where: { userId: { in: playerIds } } });
  await prisma.clubMember.deleteMany({ where: { userId: { in: playerIds } } });

  let paymentIndex = 0;
  let members = 0;
  for (const [clubIndex, orgId] of clubOrgIds.entries()) {
    const club = await prisma.club.findUnique({ where: { organizationId: orgId }, include: { courts: { where: { archivedAt: null }, orderBy: { number: 'asc' } } } });
    if (!club) continue;
    const plans = {
      annual: await prisma.membershipPlan.upsert({
        where: { clubId_name: { clubId: club.id, name: 'Annuel' } },
        update: {},
        create: { clubId: club.id, name: 'Annuel', description: 'Accès illimité aux courts pendant un an', durationMonths: 12, price: 60000 },
      }),
      quarterly: await prisma.membershipPlan.upsert({
        where: { clubId_name: { clubId: club.id, name: 'Trimestriel' } },
        update: {},
        create: { clubId: club.id, name: 'Trimestriel', durationMonths: 3, price: 20000 },
      }),
      junior: await prisma.membershipPlan.upsert({
        where: { clubId_name: { clubId: club.id, name: 'Junior (-18 ans)' } },
        update: {},
        create: { clubId: club.id, name: 'Junior (-18 ans)', durationMonths: 12, price: 30000 },
      }),
    };

    // [player, plan, started days ago, paid, method, status]
    const scenarios: [number, keyof typeof plans, number, number, string, 'ACTIVE' | 'SUSPENDED'][] =
      clubIndex === 0
        ? [
            [0, 'annual', 60, 60000, 'CASH', 'ACTIVE'], // PAID
            [1, 'annual', 10, 20000, 'WAVE', 'ACTIVE'], // PARTIALLY_PAID
            [2, 'quarterly', 5, 0, 'CASH', 'ACTIVE'], // PENDING
            [3, 'annual', 45, 0, 'CASH', 'ACTIVE'], // OVERDUE
            [4, 'quarterly', 120, 20000, 'ORANGE_MONEY', 'ACTIVE'], // EXPIRED
            [5, 'junior', 30, 30000, 'ORANGE_MONEY', 'ACTIVE'], // PAID
            [6, 'annual', 90, 30000, 'WAVE', 'SUSPENDED'], // suspended, overdue balance
          ]
        : [
            [7, 'annual', 200, 60000, 'BANK_TRANSFER', 'ACTIVE'],
            [8, 'quarterly', 20, 10000, 'WAVE', 'ACTIVE'],
            [9, 'junior', 400, 30000, 'CASH', 'ACTIVE'], // EXPIRED
            [1, 'quarterly', 3, 0, 'CASH', 'ACTIVE'],
          ];

    for (const [number, [playerIndex, planKey, startedDaysAgo, paid, method, status]] of scenarios.entries()) {
      const plan = plans[planKey];
      const startsAt = daysAgo(startedDaysAgo);
      const member = await prisma.clubMember.create({
        data: {
          clubId: club.id,
          userId: players[playerIndex].id,
          membershipNumber: String(number + 1).padStart(6, '0'),
          joinedAt: startsAt,
          status,
          statusReason: status === 'SUSPENDED' ? 'Cotisation impayée' : null,
        },
      });
      const period = await prisma.membership.create({
        data: {
          memberId: member.id,
          planId: plan.id,
          startsAt,
          expiresAt: addMonthsUtc(startsAt, plan.durationMonths),
          priceDue: plan.price,
          amountPaid: paid,
          fullyPaid: paid >= Number(plan.price),
        },
      });
      await prisma.clubMember.update({ where: { id: member.id }, data: { currentMembershipId: period.id } });
      if (paid > 0) {
        await prisma.payment.create({
          data: {
            reference: reference(++paymentIndex),
            organizationId: orgId,
            purpose: 'MEMBERSHIP',
            amount: paid,
            methodKey: method,
            externalReference: method === 'CASH' ? null : `TX${100000 + paymentIndex}`,
            payerId: players[playerIndex].id,
            paidAt: new Date(startsAt.getTime() + 2 * 60 * 60 * 1000),
            recordedById: recorderId,
            membershipId: period.id,
          },
        });
      }
      members++;
    }

    // Bookings: yesterday, today and the next days, some paid at the desk.
    const court = (i: number) => club.courts[i % Math.max(club.courts.length, 1)];
    if (!club.courts.length) continue;
    const slot = (dayOffset: number, hour: number) => {
      const d = daysAgo(-dayOffset);
      d.setUTCHours(hour, 0, 0, 0);
      return d;
    };
    const bookings: [number, number, number, number, boolean][] = [
      // [player, court, day offset, hour, paid]
      [0, 1, -1, 10, true],
      [1, 1, 0, 18, true],
      [2, 1, 0, 19, false],
      [3, 0, 1, 18, false],
      [5, 1, 1, 9, true],
      [6, 2, 3, 10, false],
    ];
    for (const [playerIndex, courtIndex, dayOffset, hour, isPaid] of bookings) {
      const c = court(courtIndex + clubIndex);
      const booking = await prisma.booking.create({
        data: {
          courtId: c.id,
          clubId: club.id,
          userId: players[(playerIndex + clubIndex * 7) % players.length].id,
          startTime: slot(dayOffset, hour),
          endTime: slot(dayOffset, hour + 1),
          status: 'CONFIRMED',
          price: c.pricePerHour,
        },
      });
      if (isPaid && c.pricePerHour) {
        await prisma.payment.create({
          data: {
            reference: reference(++paymentIndex),
            organizationId: orgId,
            purpose: 'BOOKING',
            amount: c.pricePerHour,
            methodKey: 'CASH',
            payerId: booking.userId,
            paidAt: slot(dayOffset, hour),
            recordedById: recorderId,
            bookingId: booking.id,
          },
        });
      }
    }
  }
  console.log(`Seeded membership: ${players.length} sample players, ${members} members, ${paymentIndex} payments`);
}

// ---------------------------------------------------------------------------
// Tournaments: sport profiles for the sample players, a club tournament split
// into successive tables (30 → 15 → final) with entries in every state, and a
// federation draft. Rebuilt on every run.
// ---------------------------------------------------------------------------

type SampleProfile = [gender: 'MALE' | 'FEMALE', birthYear: number, classification: string];
const SPORT_PROFILES: Record<string, SampleProfile> = {
  Seynabou: ['FEMALE', 1995, '30/2'],
  Babacar: ['MALE', 1988, '15/3'],
  Ndeye: ['FEMALE', 2001, 'NC'],
  Ousmane: ['MALE', 1979, '30/4'],
  Khadija: ['FEMALE', 1992, '15/1'],
  Lamine: ['MALE', 2003, '40'],
  Adama: ['MALE', 1990, '30'],
  Rokhaya: ['FEMALE', 1985, '4/6'],
  Ibou: ['MALE', 1998, '30/1'],
  Mame: ['MALE', 2011, 'NC'],
};

async function seedTournaments(prisma: PrismaClient, clubOrgId: string | null, federationId: string) {
  const classifications = new Map((await prisma.classification.findMany()).map((c) => [c.code, c.id]));
  if (!classifications.size || !clubOrgId) {
    console.warn('Skipped tournaments seed: no classification scale or club');
    return;
  }
  const players = new Map<string, string>();
  for (const [firstname, [gender, year, code]] of Object.entries(SPORT_PROFILES)) {
    const user = await prisma.user.findFirst({ where: { firstname, email: { endsWith: '@members.example' } } });
    if (!user) continue;
    players.set(firstname, user.id);
    await prisma.playerProfile.update({
      where: { userId: user.id },
      data: { gender, birthDate: new Date(Date.UTC(year, 4, 15)), classificationId: classifications.get(code) },
    });
  }

  const club = await prisma.club.findUniqueOrThrow({ where: { organizationId: clubOrgId }, include: { city: true } });
  const clubAdmin = await prisma.user.findUnique({ where: { msisdn: '+221770000003' } });
  const fedAdmin = await prisma.user.findUnique({ where: { msisdn: '+221770000002' } });
  const names = ['Open ASAC · Tableaux successifs', 'Championnats nationaux 2026'];
  await prisma.competition.deleteMany({ where: { name: { in: names } } });

  const DAY_MS = 24 * 60 * 60 * 1000;
  const at = (days: number, hour = 9) => {
    const d = new Date(Date.now() + days * DAY_MS);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour));
  };
  const cls = (code: string) => classifications.get(code) ?? null;

  const open = await prisma.competition.create({
    data: {
      name: names[0],
      description:
        "Tournoi homologué en tableaux successifs : les deux premiers du tableau 30 rejoignent le tableau 15, puis le tableau final. Tableau dames en parallèle.",
      category: 'Simple · 4e et 3e séries',
      status: 'REGISTRATION_OPEN',
      format: 'SINGLE_ELIMINATION',
      surface: 'HARD',
      startDate: at(12),
      endDate: at(17, 20),
      registrationOpensAt: at(-5),
      registrationClosesAt: at(9, 23),
      publishedAt: at(-5),
      hostOrganizationId: clubOrgId,
      clubId: club.id,
      location: `${club.name}, ${club.city.name}`,
      createdById: clubAdmin?.id,
      entryFee: 10000,
      maxParticipants: 40,
    },
  });
  const final = await prisma.competitionEvent.create({
    data: {
      competitionId: open.id, name: 'Simple Messieurs · Tableau final', gender: 'MEN', tableOrder: 2,
      minClassificationId: cls('15'), maxClassificationId: cls('1/6'), maxEntries: 8, entryFee: 15000, seedCount: 2,
    },
  });
  const t15 = await prisma.competitionEvent.create({
    data: {
      competitionId: open.id, name: 'Simple Messieurs · Tableau 15', gender: 'MEN', tableOrder: 1,
      minClassificationId: cls('15/5'), maxClassificationId: cls('15/1'), maxEntries: 8, entryFee: 10000,
      qualifiesIntoEventId: final.id, qualifierCount: 2,
    },
  });
  const t30 = await prisma.competitionEvent.create({
    data: {
      competitionId: open.id, name: 'Simple Messieurs · Tableau 30', gender: 'MEN', tableOrder: 0,
      minClassificationId: cls('30/5'), maxClassificationId: cls('30'), maxEntries: 16, entryFee: 10000,
      qualifiesIntoEventId: t15.id, qualifierCount: 2,
    },
  });
  const ladies = await prisma.competitionEvent.create({
    data: { competitionId: open.id, name: 'Simple Dames', gender: 'WOMEN', tableOrder: 3, maxEntries: 8, entryFee: 10000, finalSet: 'SUPER_TIEBREAK' },
  });

  const decided = { decidedAt: at(-2), decidedById: clubAdmin?.id };
  const entries: [string, string, Record<string, unknown>][] = [
    ['Ousmane', t30.id, { status: 'APPROVED', ...decided }],
    ['Adama', t30.id, { status: 'APPROVED', ...decided }],
    ['Ibou', t30.id, { status: 'PENDING' }],
    // Classified 40: below the table's floor, shown as ineligible.
    ['Lamine', t30.id, { status: 'PENDING', eligibility: { issues: ['CLASSIFICATION_TOO_WEAK'], override: null } }],
    ['Babacar', t15.id, { status: 'APPROVED', seed: 1, ...decided }],
    ['Seynabou', ladies.id, { status: 'APPROVED', ...decided }],
    ['Khadija', ladies.id, { status: 'APPROVED', seed: 1, ...decided }],
    ['Rokhaya', ladies.id, { status: 'PENDING' }],
    ['Ndeye', ladies.id, { status: 'WAITLISTED', ...decided }],
    ['Mame', ladies.id, { status: 'REJECTED', rejectionReason: 'Tableau réservé aux joueuses', ...decided }],
  ];
  for (const [index, [firstname, eventId, fields]] of entries.entries()) {
    const userId = players.get(firstname);
    if (!userId) continue;
    await prisma.competitionParticipant.create({
      data: { competitionId: open.id, eventId, userId, registeredAt: at(-4 + index * 0.2), ...fields },
    });
  }
  await prisma.auditLog.create({
    data: {
      actorId: clubAdmin?.id ?? null,
      action: 'tournament.created',
      entityType: 'Competition',
      entityId: open.id,
      organizationId: clubOrgId,
      competitionId: open.id,
      after: { name: open.name, events: 4 },
      createdAt: at(-6),
    },
  });

  const national = await prisma.competition.create({
    data: {
      name: names[1],
      description: 'Championnats nationaux individuels (brouillon en préparation).',
      category: 'Simple Messieurs & Dames',
      status: 'DRAFT',
      format: 'SINGLE_ELIMINATION',
      surface: 'HARD',
      startDate: at(45),
      endDate: at(51, 20),
      registrationClosesAt: at(38, 23),
      hostOrganizationId: federationId,
      createdById: fedAdmin?.id,
      entryFee: 20000,
      maxParticipants: 64,
    },
  });
  await prisma.competitionEvent.createMany({
    data: [
      { competitionId: national.id, name: 'Simple Messieurs', gender: 'MEN', tableOrder: 0, maxEntries: 32, entryFee: 20000, seedCount: 8 },
      { competitionId: national.id, name: 'Simple Dames', gender: 'WOMEN', tableOrder: 1, maxEntries: 32, entryFee: 20000, seedCount: 8 },
    ],
  });
  console.log('Seeded tournaments: successive tables at', club.name, '+ federation draft');
}
