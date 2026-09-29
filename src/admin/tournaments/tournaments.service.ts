import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CompetitionMatchStatus,
  CompetitionStatus,
  DrawStatus,
  OrganizationStatus,
  OrganizationType,
  Prisma,
  RegistrationStatus,
  RoleScope,
  UserStatus,
} from '@prisma/client';
import { AuditService } from '../../audit/audit.service.js';
import { AuthzService } from '../../authz/authz.service.js';
import { COMPETITION_ORGANIZER_ROLE_KEY } from '../../authz/default-roles.js';
import { GLOBAL_SCOPE, holds, scopeFilter, type Grant, type Scope } from '../../authz/scope.js';
import { orderBy, pageArgs, searchText, toPage } from '../../common/pagination.js';
import { maskPhone, personSearchWhere } from '../../common/person-search.js';
import { t } from '../../i18n/i18n.js';
import {
  tournamentCancelled,
  tournamentInterrupted,
  tournamentResumed,
} from '../../notifications/notification-messages.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RoleGrantsService } from '../users/role-grants.service.js';
import { EventsService } from './events.service.js';
import {
  availableTransitions,
  canInterrupt,
  datesValid,
  isEditable,
  registrationIsOpen,
  transitionBlockers,
  type LifecycleFacts,
} from './tournament-lifecycle.js';
import type {
  CreateTournamentDto,
  InterruptDto,
  ListTournamentsQueryDto,
  ResumeDto,
  StaffGrantDto,
  TournamentDto,
  TransitionDto,
} from './tournaments.dto.js';

type Tx = Prisma.TransactionClient;

const forbidden = (key: Parameters<typeof t>[0]) =>
  new ForbiddenException({ message: t(key), code: 'FORBIDDEN' });

const ACTIVE_ENTRIES: RegistrationStatus[] = [
  RegistrationStatus.PENDING,
  RegistrationStatus.APPROVED,
  RegistrationStatus.WAITLISTED,
];

/** Fields copied from the DTO as they are. */
const TOURNAMENT_FIELDS = [
  'name',
  'location',
  'startDate',
  'endDate',
  'registrationOpensAt',
  'registrationClosesAt',
  'surface',
  'description',
  'category',
  'bannerUrl',
  'visibility',
] as const;

const pick = <T extends object, K extends keyof T>(source: T, keys: readonly K[]) =>
  Object.fromEntries(keys.filter((k) => source[k] !== undefined).map((k) => [k, source[k]])) as Pick<T, K>;

const mayHost = (grants: readonly Grant[], chain: Scope[]) =>
  holds(grants, 'tournament.create', chain) && holds(grants, 'tournament.update', chain);

const person = { select: { id: true, firstname: true, lastname: true } } as const;

@Injectable()
export class TournamentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly grants: RoleGrantsService,
    private readonly events: EventsService,
  ) {}

  // Lists -------------------------------------------------------------

  /** Tournaments the actor may see, newest first by default. */
  async list(actorGrants: readonly Grant[], query: ListTournamentsQueryDto) {
    const scope = scopeFilter(actorGrants, 'tournament.view');
    const q = searchText(query.q);
    const where: Prisma.CompetitionWhereInput = {
      AND: [
        scope.global
          ? {}
          : { OR: [{ id: { in: scope.competitionIds } }, { hostOrganizationId: { in: scope.organizationIds } }] },
        query.status ? { status: query.status } : {},
        query.hostOrganizationId ? { hostOrganizationId: query.hostOrganizationId } : {},
        query.from ? { endDate: { gte: query.from } } : {},
        query.to ? { startDate: { lte: query.to } } : {},
        q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { location: { contains: q, mode: 'insensitive' } }] } : {},
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.competition.findMany({
        where,
        orderBy: [orderBy(query.sort, ['startDate', 'name', 'createdAt', 'status'], { field: 'startDate', direction: 'desc' }), { id: 'asc' }],
        ...pageArgs(query),
        select: {
          id: true,
          name: true,
          status: true,
          startDate: true,
          endDate: true,
          bannerUrl: true,
          location: true,
          visibility: true,
          hostOrganization: { select: { id: true, name: true, type: true } },
          club: { select: { id: true, name: true } },
          _count: { select: { events: true } },
        },
      }),
      this.prisma.competition.count({ where }),
    ]);
    const counts = await this.prisma.competitionParticipant.groupBy({
      by: ['competitionId', 'status'],
      where: { competitionId: { in: rows.map((r) => r.id) }, status: { in: [RegistrationStatus.PENDING, RegistrationStatus.APPROVED] } },
      _count: { _all: true },
    });
    const count = (id: string, status: RegistrationStatus) =>
      counts.find((c) => c.competitionId === id && c.status === status)?._count._all ?? 0;
    return toPage(
      rows.map(({ _count, ...row }) => ({
        ...row,
        eventCount: _count.events,
        entries: { approved: count(row.id, RegistrationStatus.APPROVED), pending: count(row.id, RegistrationStatus.PENDING) },
      })),
      total,
      query,
    );
  }

  /**
   * Organizations the actor may host a tournament for, and whether they may
   * run one independently. Hosting for an organization takes creating AND
   * running tournaments there: an independent organizer's global
   * `tournament.create` doesn't let them put a club's name on one.
   */
  async hostOptions(actorGrants: readonly Grant[]) {
    const everywhere = mayHost(actorGrants, [GLOBAL_SCOPE]);
    const orgIds = scopeFilter(actorGrants, 'tournament.update').organizationIds.filter((id) =>
      mayHost(actorGrants, [{ type: RoleScope.ORGANIZATION, id }, GLOBAL_SCOPE]),
    );
    const organizations = await this.prisma.organization.findMany({
      where: { status: OrganizationStatus.ACTIVE, ...(everywhere ? {} : { id: { in: orgIds } }) },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
      take: 200,
      select: { id: true, name: true, type: true, club: { select: { id: true } } },
    });
    return {
      independent: holds(actorGrants, 'tournament.create', [GLOBAL_SCOPE]),
      organizations: organizations.map(({ club, ...org }) => ({ ...org, clubId: club?.id ?? null })),
    };
  }

  // Detail / dashboard ------------------------------------------------

  async detail(id: string) {
    const competition = await this.prisma.competition.findUnique({
      where: { id },
      include: {
        hostOrganization: { select: { id: true, name: true, type: true } },
        club: { select: { id: true, name: true } },
        createdBy: person,
        events: {
          orderBy: [{ tableOrder: 'asc' }, { createdAt: 'asc' }],
          include: {
            minClassification: { select: { id: true, code: true, rank: true } },
            maxClassification: { select: { id: true, code: true, rank: true } },
            qualifiesIntoEvent: { select: { id: true, name: true } },
          },
        },
        interruptions: {
          orderBy: { startedAt: 'desc' },
          take: 10,
          include: { startedBy: person, resumedBy: person },
        },
      },
    });
    if (!competition) throw new NotFoundException(t('errors.tournaments.notFound'));

    const [entryCounts, qualifierCounts, players, staff, activity, facts] = await Promise.all([
      this.prisma.competitionParticipant.groupBy({
        by: ['eventId', 'status'],
        where: { competitionId: id },
        _count: { _all: true },
      }),
      this.prisma.competitionParticipant.groupBy({
        by: ['eventId'],
        where: { competitionId: id, status: { in: ACTIVE_ENTRIES }, entryType: { in: ['QUALIFIER', 'LUCKY_LOSER'] } },
        _count: { _all: true },
      }),
      this.prisma.competitionParticipant.findMany({
        where: { competitionId: id, status: RegistrationStatus.APPROVED },
        distinct: ['userId'],
        select: { userId: true },
      }),
      this.prisma.userRole.count({ where: { competitionId: id, revokedAt: null } }),
      this.prisma.auditLog.findMany({
        where: { competitionId: id },
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: { id: true, action: true, entityType: true, createdAt: true, reason: true, actor: person },
      }),
      this.lifecycleFacts(this.prisma, id),
    ]);

    const byStatus = (eventId?: string) =>
      Object.fromEntries(
        Object.values(RegistrationStatus).map((status) => [
          status,
          entryCounts
            .filter((c) => c.status === status && (!eventId || c.eventId === eventId))
            .reduce((sum, c) => sum + c._count._all, 0),
        ]),
      ) as Record<RegistrationStatus, number>;

    const { interruptions, events, ...rest } = competition;
    return {
      ...rest,
      registrationOpenNow: registrationIsOpen(competition),
      editable: isEditable(competition.status),
      events: events.map((event) => ({
        ...event,
        entries: byStatus(event.id),
        qualifiersEntered: qualifierCounts.find((c) => c.eventId === event.id)?._count._all ?? 0,
      })),
      transitions: availableTransitions(competition.status, facts),
      interruption: interruptions.find((i) => !i.resumedAt) ?? null,
      interruptions,
      stats: { entries: byStatus(), players: players.length, staff },
      tableIssues: this.events.issuesOf(events),
      activity,
    };
  }

  private async lifecycleFacts(db: Tx | PrismaService, id: string): Promise<LifecycleFacts> {
    const competition = await db.competition.findUniqueOrThrow({
      where: { id },
      select: { startDate: true, endDate: true, registrationClosesAt: true },
    });
    const [eventCount, eventsWithoutPublishedDraw, unfinishedMatches] = await Promise.all([
      db.competitionEvent.count({ where: { competitionId: id } }),
      db.competitionEvent.count({
        where: { competitionId: id, drawStatus: { in: [DrawStatus.NOT_GENERATED, DrawStatus.DRAFT] } },
      }),
      db.competitionMatch.count({
        where: {
          round: { competitionId: id },
          status: { notIn: [CompetitionMatchStatus.COMPLETED, CompetitionMatchStatus.BYE] },
        },
      }),
    ]);
    return { ...competition, eventCount, eventsWithoutPublishedDraw, unfinishedMatches };
  }

  // Create / edit -----------------------------------------------------

  async create(actorGrants: readonly Grant[], actorId: string, dto: CreateTournamentDto) {
    const hostId = dto.hostOrganizationId ?? null;
    let venueClubId = dto.clubId ?? null;

    if (hostId) {
      const host = await this.prisma.organization.findUnique({
        where: { id: hostId },
        select: { id: true, status: true, type: true, club: { select: { id: true } } },
      });
      if (!host) throw new NotFoundException(t('errors.admin.organizationNotFound'));
      const chain = await this.authz.scopeChain('organization', hostId);
      if (host.status !== OrganizationStatus.ACTIVE || !mayHost(actorGrants, chain)) {
        throw forbidden('errors.tournaments.hostNotAllowed');
      }
      // A club hosting its own tournament plays at home unless told otherwise.
      if (host.type === OrganizationType.CLUB && dto.clubId === undefined) venueClubId = host.club?.id ?? null;
    } else if (!holds(actorGrants, 'tournament.create', [GLOBAL_SCOPE])) {
      throw forbidden('errors.tournaments.independentNotAllowed');
    }
    await this.assertVenue(venueClubId);
    this.assertDates(dto.startDate, dto.endDate, dto.registrationClosesAt ?? null);

    const competition = await this.prisma.$transaction(async (tx) => {
      const created = await tx.competition.create({
        data: {
          ...pick(dto, TOURNAMENT_FIELDS),
          name: dto.name,
          startDate: dto.startDate,
          endDate: dto.endDate,
          format: dto.events?.[0]?.format ?? 'SINGLE_ELIMINATION',
          status: CompetitionStatus.DRAFT,
          hostOrganizationId: hostId,
          clubId: venueClubId,
          createdById: actorId,
        },
      });
      await this.events.createMany(tx, created.id, dto.events ?? []);
      await this.events.validateAndSync(tx, created.id);
      await this.audit.record(
        {
          actorId,
          action: 'tournament.created',
          entityType: 'Competition',
          entityId: created.id,
          organizationId: hostId,
          competitionId: created.id,
          after: { ...created, events: dto.events?.map((e) => e.name) ?? [] },
        },
        tx,
      );

      // Whoever creates a tournament runs it. Organization staff already do
      // through the host; an independent organizer needs a grant on it.
      const chain: Scope[] = [
        { type: RoleScope.COMPETITION, id: created.id },
        ...(hostId ? [{ type: RoleScope.ORGANIZATION, id: hostId } as const] : []),
        GLOBAL_SCOPE,
      ];
      if (!holds(actorGrants, 'tournament.update', chain)) {
        const role = await tx.role.findUniqueOrThrow({ where: { key: COMPETITION_ORGANIZER_ROLE_KEY } });
        const grant = await tx.userRole.create({
          data: { userId: actorId, roleId: role.id, competitionId: created.id, grantedById: actorId },
        });
        await this.audit.record(
          {
            actorId,
            action: 'user.roles.granted',
            entityType: 'User',
            entityId: actorId,
            competitionId: created.id,
            after: { grantId: grant.id, role: role.key, competitionId: created.id },
            reason: 'Tournament creator',
          },
          tx,
        );
      }
      return created;
    });
    return this.detail(competition.id);
  }

  async update(actorId: string, id: string, dto: TournamentDto) {
    const before = await this.competition(id);
    if (!isEditable(before.status)) throw new ConflictException(t('errors.tournaments.notEditable'));
    if (dto.clubId !== undefined) await this.assertVenue(dto.clubId);
    this.assertDates(
      dto.startDate ?? before.startDate,
      dto.endDate ?? before.endDate,
      dto.registrationClosesAt === undefined ? before.registrationClosesAt : dto.registrationClosesAt,
    );
    await this.prisma.$transaction(async (tx) => {
      const after = await tx.competition.update({
        where: { id },
        data: { ...pick(dto, TOURNAMENT_FIELDS), ...(dto.clubId !== undefined ? { clubId: dto.clubId } : {}) },
      });
      await this.audit.record(
        {
          actorId,
          action: 'tournament.updated',
          entityType: 'Competition',
          entityId: id,
          organizationId: before.hostOrganizationId,
          competitionId: id,
          before,
          after,
        },
        tx,
      );
    });
    return this.detail(id);
  }

  async remove(actorId: string, id: string) {
    const competition = await this.competition(id);
    if (competition.status !== CompetitionStatus.DRAFT) {
      throw new ConflictException(t('errors.tournaments.deleteOnlyDraft'));
    }
    await this.prisma.$transaction(async (tx) => {
      // Grants scoped to it would otherwise point at nothing.
      await tx.userRole.deleteMany({ where: { competitionId: id } });
      await tx.competition.delete({ where: { id } });
      await this.audit.record(
        {
          actorId,
          action: 'tournament.deleted',
          entityType: 'Competition',
          entityId: id,
          organizationId: competition.hostOrganizationId,
          before: competition,
        },
        tx,
      );
    });
  }

  // Lifecycle ---------------------------------------------------------

  async transition(actorId: string, id: string, dto: TransitionDto) {
    const result = await this.prisma.$transaction(async (tx) => {
      // Row lock: two directors clicking at once can't both move it.
      await tx.$queryRaw`SELECT id FROM "Competition" WHERE id = ${id} FOR UPDATE`;
      const competition = await tx.competition.findUnique({ where: { id } });
      if (!competition) throw new NotFoundException(t('errors.tournaments.notFound'));
      const blockers = transitionBlockers(competition.status, dto.to, await this.lifecycleFacts(tx, id), dto.reason);
      if (blockers.includes('NOT_ALLOWED')) {
        throw new ConflictException({ message: t('errors.tournaments.transitionNotAllowed'), code: 'TRANSITION_NOT_ALLOWED' });
      }
      if (blockers.includes('REASON_REQUIRED')) {
        throw new BadRequestException({ message: t('errors.tournaments.reasonRequired'), code: 'REASON_REQUIRED' });
      }
      if (blockers.length) {
        throw new ConflictException({ message: t('errors.tournaments.transitionBlocked'), code: 'TRANSITION_BLOCKED', blockers });
      }
      const now = new Date();
      const updated = await tx.competition.update({
        where: { id },
        data: {
          status: dto.to,
          ...(dto.to === CompetitionStatus.REGISTRATION_OPEN && !competition.publishedAt ? { publishedAt: now } : {}),
          ...(dto.to === CompetitionStatus.CANCELLED ? { cancelledAt: now, cancelReason: dto.reason } : {}),
        },
      });
      await this.audit.record(
        {
          actorId,
          action: 'tournament.status.changed',
          entityType: 'Competition',
          entityId: id,
          organizationId: competition.hostOrganizationId,
          competitionId: id,
          before: { status: competition.status },
          after: { status: dto.to },
          reason: dto.reason,
        },
        tx,
      );
      return updated;
    });

    if (dto.to === CompetitionStatus.CANCELLED && dto.notify !== false) {
      await this.notifyParticipants(id, tournamentCancelled(id, result.name, dto.reason ?? ''));
    }
    return this.detail(id);
  }

  async interrupt(actorId: string, id: string, dto: InterruptDto) {
    const competition = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Competition" WHERE id = ${id} FOR UPDATE`;
      const row = await tx.competition.findUnique({ where: { id } });
      if (!row) throw new NotFoundException(t('errors.tournaments.notFound'));
      if (!canInterrupt(row.status)) throw new ConflictException(t('errors.tournaments.notInterruptible'));
      const interruption = await tx.competitionInterruption.create({
        data: {
          competitionId: id,
          reason: dto.reason,
          note: dto.note,
          previousStatus: row.status,
          startedById: actorId,
          participantsNotified: dto.notify !== false,
        },
      });
      await tx.competition.update({ where: { id }, data: { status: CompetitionStatus.INTERRUPTED } });
      await this.audit.record(
        {
          actorId,
          action: 'tournament.interrupted',
          entityType: 'Competition',
          entityId: id,
          organizationId: row.hostOrganizationId,
          competitionId: id,
          after: interruption,
          reason: dto.note ?? dto.reason,
        },
        tx,
      );
      return row;
    });
    if (dto.notify !== false) {
      await this.notifyParticipants(id, tournamentInterrupted(id, competition.name, dto.reason, dto.note));
    }
    return this.detail(id);
  }

  async resume(actorId: string, id: string, dto: ResumeDto) {
    const competition = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Competition" WHERE id = ${id} FOR UPDATE`;
      const row = await tx.competition.findUnique({ where: { id } });
      if (!row) throw new NotFoundException(t('errors.tournaments.notFound'));
      const open = await tx.competitionInterruption.findFirst({
        where: { competitionId: id, resumedAt: null },
        orderBy: { startedAt: 'desc' },
      });
      if (row.status !== CompetitionStatus.INTERRUPTED || !open) {
        throw new ConflictException(t('errors.tournaments.notInterrupted'));
      }
      await tx.competitionInterruption.update({
        where: { id: open.id },
        data: { resumedAt: new Date(), resumedById: actorId },
      });
      await tx.competition.update({ where: { id }, data: { status: open.previousStatus } });
      await this.audit.record(
        {
          actorId,
          action: 'tournament.resumed',
          entityType: 'Competition',
          entityId: id,
          organizationId: row.hostOrganizationId,
          competitionId: id,
          before: { status: row.status },
          after: { status: open.previousStatus },
        },
        tx,
      );
      return row;
    });
    if (dto.notify !== false) await this.notifyParticipants(id, tournamentResumed(id, competition.name));
    return this.detail(id);
  }

  /** Players and partners of every active entry, once each. */
  private async notifyParticipants(competitionId: string, message: Parameters<NotificationsService['notify']>[1]) {
    const entries = await this.prisma.competitionParticipant.findMany({
      where: { competitionId, status: { in: ACTIVE_ENTRIES } },
      select: { userId: true, partnerUserId: true },
    });
    const userIds = new Set(entries.flatMap((e) => [e.userId, ...(e.partnerUserId ? [e.partnerUserId] : [])]));
    for (const userId of userIds) await this.notifications.notify(userId, message);
  }

  // Staff -------------------------------------------------------------

  async staff(id: string) {
    await this.competition(id);
    const [grants, roles] = await Promise.all([
      this.prisma.userRole.findMany({
        where: { competitionId: id, revokedAt: null },
        orderBy: [{ grantedAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          grantedAt: true,
          role: { select: { id: true, key: true, name: true } },
          user: { select: { id: true, firstname: true, lastname: true, email: true, status: true, playerProfile: { select: { avatarUrl: true } } } },
          grantedBy: person,
        },
      }),
      this.prisma.role.findMany({
        where: { scope: RoleScope.COMPETITION },
        orderBy: { name: 'asc' },
        select: { id: true, key: true, name: true, description: true },
      }),
    ]);
    return { grants, roles };
  }

  /** People who could join the team: active accounts matching the search. */
  async staffCandidates(id: string, q: string) {
    await this.competition(id);
    const rows = await this.prisma.user.findMany({
      where: { AND: [personSearchWhere(q), { status: UserStatus.ACTIVE }] },
      take: 10,
      orderBy: [{ lastname: 'asc' }, { firstname: 'asc' }],
      select: { id: true, firstname: true, lastname: true, msisdn: true, playerProfile: { select: { avatarUrl: true } } },
    });
    return rows.map(({ msisdn, ...user }) => ({ ...user, phone: maskPhone(msisdn) }));
  }

  async addStaff(actorGrants: readonly Grant[], actorId: string, id: string, dto: StaffGrantDto) {
    await this.competition(id);
    const role = await this.prisma.role.findUnique({ where: { key: dto.roleKey } });
    if (!role || role.scope !== RoleScope.COMPETITION) {
      throw new BadRequestException(t('errors.tournaments.staffRoleInvalid'));
    }
    await this.grants.grant(actorGrants, actorId, dto.userId, { roleId: role.id, competitionId: id }, 'tournament.staff.manage');
    return this.staff(id);
  }

  async removeStaff(actorGrants: readonly Grant[], actorId: string, id: string, grantId: string, reason?: string) {
    const grant = await this.prisma.userRole.findFirst({ where: { id: grantId, competitionId: id, revokedAt: null } });
    if (!grant) throw new NotFoundException(t('errors.admin.grantNotFound'));
    await this.grants.revoke(actorGrants, actorId, grant.userId, grantId, reason, 'tournament.staff.manage');
    return this.staff(id);
  }

  // Helpers -----------------------------------------------------------

  private async competition(id: string) {
    const row = await this.prisma.competition.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(t('errors.tournaments.notFound'));
    return row;
  }

  private async assertVenue(clubId: string | null) {
    if (!clubId) return;
    const club = await this.prisma.club.findUnique({ where: { id: clubId }, select: { id: true } });
    if (!club) throw new NotFoundException(t('errors.tournaments.venueNotFound'));
  }

  private assertDates(startDate: Date, endDate: Date, registrationClosesAt: Date | null) {
    if (!datesValid({ startDate, endDate, registrationClosesAt })) {
      throw new BadRequestException({ message: t('errors.tournaments.invalidDates'), code: 'INVALID_DATES' });
    }
  }
}
