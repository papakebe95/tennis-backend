import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EntryType, EventDiscipline, Prisma, RegistrationStatus } from '@prisma/client';
import { AuditService } from '../../audit/audit.service.js';
import { orderBy, pageArgs, searchText, toPage } from '../../common/pagination.js';
import { maskPhone, personSearchWhere } from '../../common/person-search.js';
import { t } from '../../i18n/i18n.js';
import { registrationDecided, type RegistrationOutcome } from '../../notifications/notification-messages.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { entryIssues, sportAge, type EligibilityIssue } from './eligibility.js';
import { checkEntry, eventRulesSelect, toRules, weakestScaleRank } from './entry-facts.js';
import { entriesOpen } from './tournament-lifecycle.js';
import type { CreateEntryDto, DecisionDto, ListRegistrationsQueryDto } from './tournaments.dto.js';

type Tx = Prisma.TransactionClient;
const S = RegistrationStatus;

export type Decision = 'approve' | 'reject' | 'waitlist' | 'withdraw';

/** Which statuses each decision starts from, and where it leads. */
export const DECISIONS: Record<Decision, { from: RegistrationStatus[]; to: RegistrationStatus; outcome: RegistrationOutcome }> = {
  approve: { from: [S.PENDING, S.WAITLISTED], to: S.APPROVED, outcome: 'registrationApproved' },
  reject: { from: [S.PENDING, S.WAITLISTED], to: S.REJECTED, outcome: 'registrationRejected' },
  waitlist: { from: [S.PENDING, S.APPROVED], to: S.WAITLISTED, outcome: 'registrationWaitlisted' },
  withdraw: { from: [S.PENDING, S.APPROVED, S.WAITLISTED], to: S.WITHDRAWN, outcome: 'registrationWithdrawn' },
};

const ACTIVE: RegistrationStatus[] = [S.PENDING, S.APPROVED, S.WAITLISTED];

const playerSelect = {
  id: true,
  firstname: true,
  lastname: true,
  msisdn: true,
  playerProfile: {
    select: {
      avatarUrl: true,
      gender: true,
      birthDate: true,
      classification: { select: { id: true, code: true, rank: true } },
    },
  },
} satisfies Prisma.UserSelect;

type PlayerRow = Prisma.UserGetPayload<{ select: typeof playerSelect }>;

const eventSelect = {
  id: true,
  name: true,
  competitionId: true,
  maxEntries: true,
  qualifierCount: true,
  seedCount: true,
  ...eventRulesSelect,
  competition: { select: { id: true, name: true, status: true, startDate: true, hostOrganizationId: true } },
} satisfies Prisma.CompetitionEventSelect;

type EventRow = Prisma.CompetitionEventGetPayload<{ select: typeof eventSelect }>;

@Injectable()
export class RegistrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // Reading ------------------------------------------------------------

  async list(eventId: string, query: ListRegistrationsQueryDto) {
    const event = await this.event(eventId);
    const q = searchText(query.q);
    const where: Prisma.CompetitionParticipantWhereInput = {
      eventId,
      status: query.status,
      entryType: query.entryType,
      ...(q ? { OR: [{ user: personSearchWhere(q) }, { partner: personSearchWhere(q) }] } : {}),
    };
    const sort = orderBy(query.sort, ['registeredAt', 'seed', 'status'], { field: 'registeredAt', direction: 'asc' });
    const [rows, total, counts, weakest] = await Promise.all([
      this.prisma.competitionParticipant.findMany({
        where,
        orderBy: [
          'seed' in sort ? { seed: { sort: sort.seed!, nulls: 'last' } } : sort,
          { registeredAt: 'asc' },
          { id: 'asc' },
        ],
        ...pageArgs(query),
        include: {
          user: { select: playerSelect },
          partner: { select: playerSelect },
          decidedBy: { select: { id: true, firstname: true, lastname: true } },
          sourceEvent: { select: { id: true, name: true } },
        },
      }),
      this.prisma.competitionParticipant.count({ where }),
      this.prisma.competitionParticipant.groupBy({ by: ['status'], where: { eventId }, _count: { _all: true } }),
      weakestScaleRank(this.prisma),
    ]);
    const rules = toRules(event);
    const on = event.competition.startDate;
    return {
      ...toPage(
        rows.map(({ user, partner, ...entry }) => ({
          ...entry,
          player: this.player(user, on),
          partner: partner ? this.player(partner, on) : null,
          // Live check: a profile may have changed since the entry was made.
          issues: entryIssues(rules, [user, ...(partner ? [partner] : [])].map(facts), on, entry.entryType, weakest),
        })),
        total,
        query,
      ),
      counts: Object.fromEntries(Object.values(S).map((s) => [s, counts.find((c) => c.status === s)?._count._all ?? 0])),
      capacity: event.maxEntries,
    };
  }

  /** Players to add to an event, with what would stop them. */
  async candidates(eventId: string, q: string) {
    const event = await this.event(eventId);
    const rows = await this.prisma.user.findMany({
      where: personSearchWhere(q),
      take: 10,
      orderBy: [{ lastname: 'asc' }, { firstname: 'asc' }],
      select: {
        ...playerSelect,
        competitionParticipant: { where: { eventId, status: { in: ACTIVE } }, select: { id: true } },
        competitionPartnerOf: { where: { eventId, status: { in: ACTIVE } }, select: { id: true } },
      },
    });
    const rules = toRules(event);
    const on = event.competition.startDate;
    const weakest = await weakestScaleRank(this.prisma);
    return rows.map(({ competitionParticipant, competitionPartnerOf, ...user }) => ({
      ...this.player(user, on),
      alreadyEntered: competitionParticipant.length + competitionPartnerOf.length > 0,
      issues: entryIssues({ ...rules, discipline: EventDiscipline.SINGLES }, [facts(user)], on, EntryType.DIRECT, weakest),
    }));
  }

  /** Lower-table players who can fill this event's qualifier places. */
  async qualifierSources(eventId: string) {
    const event = await this.event(eventId);
    return this.prisma.competitionEvent.findMany({
      where: { qualifiesIntoEventId: eventId, competitionId: event.competitionId },
      orderBy: { tableOrder: 'asc' },
      select: { id: true, name: true, qualifierCount: true },
    });
  }

  // Writing ------------------------------------------------------------

  async create(actorId: string, eventId: string, dto: CreateEntryDto) {
    const event = await this.event(eventId);
    this.assertEntriesOpen(event);
    const entryType = dto.entryType ?? EntryType.DIRECT;
    const status = dto.status ?? S.APPROVED;
    const userIds = await this.entrants(event, dto);

    if (entryType === EntryType.QUALIFIER || entryType === EntryType.LUCKY_LOSER) {
      const source = dto.sourceEventId
        ? await this.prisma.competitionEvent.findFirst({ where: { id: dto.sourceEventId, qualifiesIntoEventId: eventId } })
        : null;
      if (!source) throw new BadRequestException(t('errors.tournaments.qualifierSourceInvalid'));
    }

    const entry = await this.prisma.$transaction(async (tx) => {
      await this.lockEvent(tx, eventId);
      const taken = await tx.competitionParticipant.findFirst({
        where: {
          eventId,
          status: { in: ACTIVE },
          OR: [{ userId: { in: userIds } }, { partnerUserId: { in: userIds } }],
        },
      });
      if (taken) throw new ConflictException({ message: t('errors.tournaments.alreadyEntered'), code: 'ALREADY_ENTERED' });

      const eligibility = await this.eligibility(tx, event, userIds, entryType, dto.overrideReason, status !== S.APPROVED);
      if (status === S.APPROVED) await this.assertCapacity(tx, event);

      const data = {
        partnerUserId: userIds[1] ?? null,
        status,
        entryType,
        sourceEventId: entryType === EntryType.QUALIFIER || entryType === EntryType.LUCKY_LOSER ? dto.sourceEventId : null,
        registeredAt: new Date(),
        decidedAt: status === S.PENDING ? null : new Date(),
        decidedById: status === S.PENDING ? null : actorId,
        rejectionReason: null,
        seed: null,
        eligibility,
      };
      // An earlier rejected or withdrawn entry of the same player is reused.
      const row = await tx.competitionParticipant.upsert({
        where: { eventId_userId: { eventId, userId: userIds[0] } },
        update: data,
        create: { ...data, competitionId: event.competitionId, eventId, userId: userIds[0] },
      });
      await this.audit.record(
        {
          actorId,
          action: 'registration.created',
          entityType: 'CompetitionParticipant',
          entityId: row.id,
          organizationId: event.competition.hostOrganizationId,
          competitionId: event.competitionId,
          after: { event: event.name, userIds, status, entryType, eligibility },
          reason: dto.overrideReason,
        },
        tx,
      );
      return row;
    });

    if (status === S.APPROVED) await this.notify(entry.id, 'registrationApproved');
    if (status === S.WAITLISTED) await this.notify(entry.id, 'registrationWaitlisted');
    return entry;
  }

  async decide(actorId: string, id: string, decision: Decision, dto: DecisionDto) {
    const rule = DECISIONS[decision];
    const before = await this.prisma.competitionParticipant.findUnique({ where: { id }, include: { drawSlot: { select: { id: true } } } });
    if (!before) throw new NotFoundException(t('errors.tournaments.registrationNotFound'));
    // A placed player leaves the draw through a replacement, which keeps the
    // bracket consistent.
    if (before.drawSlot && decision !== 'approve') {
      throw new ConflictException({ message: t('errors.draws.entryInDraw'), code: 'ENTRY_IN_DRAW' });
    }
    const event = await this.event(before.eventId);
    this.assertEntriesOpen(event);
    if (!rule.from.includes(before.status)) {
      throw new ConflictException({ message: t('errors.tournaments.invalidDecision'), code: 'INVALID_DECISION' });
    }
    if ((decision === 'reject' || decision === 'withdraw') && !dto.reason?.trim()) {
      throw new BadRequestException({ message: t('errors.tournaments.reasonRequired'), code: 'REASON_REQUIRED' });
    }

    await this.prisma.$transaction(async (tx) => {
      await this.lockEvent(tx, before.eventId);
      let eligibility: Prisma.InputJsonValue | undefined;
      if (decision === 'approve') {
        const userIds = [before.userId, ...(before.partnerUserId ? [before.partnerUserId] : [])];
        eligibility = await this.eligibility(tx, event, userIds, before.entryType, dto.overrideReason, false);
        await this.assertCapacity(tx, event);
      }
      const after = await tx.competitionParticipant.update({
        where: { id },
        data: {
          status: rule.to,
          decidedAt: new Date(),
          decidedById: actorId,
          rejectionReason: decision === 'reject' || decision === 'withdraw' ? dto.reason!.trim() : null,
          // A seed belongs to an accepted entry only.
          ...(rule.to !== S.APPROVED ? { seed: null } : {}),
          ...(eligibility ? { eligibility } : {}),
        },
      });
      await this.audit.record(
        {
          actorId,
          action: `registration.${decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : decision === 'waitlist' ? 'waitlisted' : 'withdrawn'}`,
          entityType: 'CompetitionParticipant',
          entityId: id,
          organizationId: event.competition.hostOrganizationId,
          competitionId: event.competitionId,
          before: { status: before.status, seed: before.seed },
          after: { status: after.status, eligibility: after.eligibility },
          reason: dto.reason ?? dto.overrideReason,
        },
        tx,
      );
    });

    if (dto.notify !== false) await this.notify(id, rule.outcome, dto.reason);
  }

  async setSeed(actorId: string, id: string, seed: number | null) {
    const entry = await this.prisma.competitionParticipant.findUnique({ where: { id } });
    if (!entry) throw new NotFoundException(t('errors.tournaments.registrationNotFound'));
    const event = await this.event(entry.eventId);
    this.assertEntriesOpen(event);
    if (seed !== null && entry.status !== S.APPROVED) {
      throw new ConflictException(t('errors.tournaments.seedNotApproved'));
    }
    await this.prisma.$transaction(async (tx) => {
      await this.lockEvent(tx, entry.eventId);
      if (seed !== null) {
        const clash = await tx.competitionParticipant.findFirst({ where: { eventId: entry.eventId, seed, id: { not: id } } });
        if (clash) throw new ConflictException({ message: t('errors.tournaments.seedTaken', { seed }), code: 'SEED_TAKEN' });
      }
      await tx.competitionParticipant.update({ where: { id }, data: { seed } });
      await this.audit.record(
        {
          actorId,
          action: 'registration.seeded',
          entityType: 'CompetitionParticipant',
          entityId: id,
          organizationId: event.competition.hostOrganizationId,
          competitionId: event.competitionId,
          before: { seed: entry.seed },
          after: { seed },
        },
        tx,
      );
    });
  }

  // Helpers ------------------------------------------------------------

  /** The entry's players: the player, plus the partner in doubles. */
  private async entrants(event: EventRow, dto: CreateEntryDto): Promise<string[]> {
    const doubles = event.discipline === EventDiscipline.DOUBLES;
    if (doubles && !dto.partnerUserId) throw new BadRequestException(t('errors.tournaments.partnerRequired'));
    if (!doubles && dto.partnerUserId) throw new BadRequestException(t('errors.tournaments.partnerNotAllowed'));
    if (dto.partnerUserId === dto.userId) throw new BadRequestException(t('errors.tournaments.partnerSame'));
    const userIds = [dto.userId, ...(dto.partnerUserId ? [dto.partnerUserId] : [])];
    const found = await this.prisma.user.count({ where: { id: { in: userIds } } });
    if (found !== userIds.length) throw new NotFoundException(t('errors.tournaments.playerNotFound'));
    return userIds;
  }

  /**
   * Checks eligibility and returns the snapshot to store. Issues block an
   * accepted entry unless an override reason is given (kept in the snapshot
   * and the audit log). Pending / waitlisted entries are stored with their
   * issues and checked again at approval.
   */
  private async eligibility(
    tx: Tx,
    event: EventRow,
    userIds: string[],
    entryType: EntryType,
    overrideReason: string | undefined,
    deferred: boolean,
  ): Promise<Prisma.InputJsonValue> {
    const issues: EligibilityIssue[] = await checkEntry(tx, event, userIds, event.competition.startDate, entryType);
    const override = overrideReason?.trim() || null;
    if (issues.length && !deferred && !override) {
      throw new ConflictException({ message: t('errors.tournaments.notEligible'), code: 'NOT_ELIGIBLE', issues });
    }
    return { issues, override: issues.length ? override : null, checkedAt: new Date().toISOString() };
  }

  private async assertCapacity(tx: Tx, event: EventRow) {
    if (event.maxEntries === null) return;
    const approved = await tx.competitionParticipant.count({ where: { eventId: event.id, status: S.APPROVED } });
    if (approved >= event.maxEntries) {
      throw new ConflictException({ message: t('errors.tournaments.eventFull'), code: 'EVENT_FULL' });
    }
  }

  /** Serializes entry changes of one event (capacity, seeds, duplicates). */
  private async lockEvent(tx: Tx, eventId: string) {
    await tx.$queryRaw`SELECT id FROM "CompetitionEvent" WHERE id = ${eventId} FOR UPDATE`;
  }

  private assertEntriesOpen(event: EventRow) {
    if (!entriesOpen(event.competition.status)) {
      throw new ConflictException({ message: t('errors.tournaments.entriesClosed'), code: 'ENTRIES_CLOSED' });
    }
  }

  private async event(eventId: string): Promise<EventRow> {
    const event = await this.prisma.competitionEvent.findUnique({ where: { id: eventId }, select: eventSelect });
    if (!event) throw new NotFoundException(t('errors.tournaments.eventNotFound'));
    return event;
  }

  private player(user: PlayerRow, on: Date) {
    const profile = user.playerProfile;
    return {
      id: user.id,
      firstname: user.firstname,
      lastname: user.lastname,
      phone: maskPhone(user.msisdn),
      avatarUrl: profile?.avatarUrl ?? null,
      gender: profile?.gender ?? null,
      age: profile?.birthDate ? sportAge(profile.birthDate, on) : null,
      classification: profile?.classification ? { id: profile.classification.id, code: profile.classification.code } : null,
    };
  }

  private async notify(entryId: string, outcome: RegistrationOutcome, reason?: string) {
    const entry = await this.prisma.competitionParticipant.findUniqueOrThrow({
      where: { id: entryId },
      select: { userId: true, partnerUserId: true, event: { select: { name: true } }, competition: { select: { id: true, name: true } } },
    });
    const message = registrationDecided(outcome, entry.competition.id, entry.competition.name, entry.event.name, reason);
    for (const userId of [entry.userId, entry.partnerUserId]) {
      if (userId) await this.notifications.notify(userId, message);
    }
  }
}

const facts = (user: PlayerRow) => ({
  gender: user.playerProfile?.gender ?? null,
  birthDate: user.playerProfile?.birthDate ?? null,
  classificationRank: user.playerProfile?.classification?.rank ?? null,
});
