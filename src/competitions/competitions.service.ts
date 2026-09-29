import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CompetitionStatus,
  CompetitionVisibility,
  EventDiscipline,
  Prisma,
  RegistrationStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { registrationReceived } from '../notifications/notification-messages.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { ListCompetitionsQueryDto } from './dto/list-competitions-query.dto.js';
import { t } from '../i18n/i18n.js';
import { localize } from '../i18n/localize.js';
import { checkEntry, eventRulesSelect } from '../admin/tournaments/entry-facts.js';
import {
  entriesOpen,
  PUBLIC_STATUS_FILTER,
  publicStatus,
  registrationIsOpen,
  type PublicStatus,
} from '../admin/tournaments/tournament-lifecycle.js';

/** Entries that hold (or wait for) a place. */
export const ACTIVE_ENTRY_STATUSES: RegistrationStatus[] = [
  RegistrationStatus.PENDING,
  RegistrationStatus.APPROVED,
  RegistrationStatus.WAITLISTED,
];
/** Entries counted against the tournament's places. */
const COUNTED_STATUSES: RegistrationStatus[] = [RegistrationStatus.PENDING, RegistrationStatus.APPROVED];

/** Tournaments players can see: published and public. */
const VISIBLE: Prisma.CompetitionWhereInput = {
  status: { not: CompetitionStatus.DRAFT },
  visibility: CompetitionVisibility.PUBLIC,
};

const competitionSelect = (userId: string) =>
  ({
    id: true,
    name: true,
    bannerUrl: true,
    location: true,
    startDate: true,
    endDate: true,
    category: true,
    surface: true,
    format: true,
    status: true,
    registrationOpensAt: true,
    registrationClosesAt: true,
    description: true,
    translations: true,
    featured: true,
    maxParticipants: true,
    entryFee: true,
    club: {
      select: {
        id: true,
        name: true,
        city: { select: { name: true, translations: true } },
      },
    },
    _count: { select: { participants: { where: { status: { in: COUNTED_STATUSES } } } } },
    // At most one row: this player's own active registration.
    participants: {
      where: { OR: [{ userId }, { partnerUserId: userId }], status: { in: ACTIVE_ENTRY_STATUSES } },
      select: { id: true, status: true },
      take: 1,
    },
  }) satisfies Prisma.CompetitionSelect;

type CompetitionRow = Prisma.CompetitionGetPayload<{
  select: ReturnType<typeof competitionSelect>;
}>;

// Live first, then what is coming soonest, then the most recent results.
const STATUS_ORDER: Record<PublicStatus, number> = {
  ONGOING: 0,
  UPCOMING: 1,
  COMPLETED: 2,
};

@Injectable()
export class CompetitionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(userId: string, query: ListCompetitionsQueryDto) {
    const rows = await this.prisma.competition.findMany({
      where: {
        ...VISIBLE,
        ...(query.status ? { status: { in: PUBLIC_STATUS_FILTER[query.status] } } : {}),
      },
      select: competitionSelect(userId),
    });
    const now = new Date();
    return rows
      .map((row) => this.toView(row, now))
      .sort((a, b) => {
        if (a.status !== b.status) {
          return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
        }
        // Featured events lead their group.
        if (a.featured !== b.featured) return a.featured ? -1 : 1;
        const byStart =
          new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
        return a.status === 'COMPLETED' ? -byStart : byStart;
      })
      .slice(0, query.limit ?? 20);
  }

  async findOne(userId: string, id: string) {
    const row = await this.prisma.competition.findFirst({
      where: { id, ...VISIBLE },
      select: {
        ...competitionSelect(userId),
        participants: {
          where: { status: { in: COUNTED_STATUSES } },
          orderBy: [{ seed: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
          take: 12,
          select: {
            id: true,
            userId: true,
            partnerUserId: true,
            status: true,
            seed: true,
            user: {
              select: {
                firstname: true,
                lastname: true,
                playerProfile: { select: { avatarUrl: true, level: true } },
              },
            },
          },
        },
      },
    });
    if (!row) throw new NotFoundException(t('errors.competitions.notFound'));

    const { participants, ...rest } = row;
    const view = this.toView(
      {
        ...rest,
        participants: participants.filter((p) => p.userId === userId || p.partnerUserId === userId),
      } as unknown as CompetitionRow,
      new Date(),
    );
    return {
      ...view,
      players: participants.map((p) => ({
        userId: p.userId,
        seed: p.seed,
        name: `${p.user.firstname} ${p.user.lastname}`.trim(),
        avatarUrl: p.user.playerProfile?.avatarUrl ?? null,
        level: p.user.playerProfile?.level ?? null,
      })),
    };
  }

  /**
   * Signs the player up from the app. The app sends only the tournament, so
   * the entry goes to the first singles table (lowest first) the player is
   * eligible for; the organizer then approves it in the back-office.
   */
  async register(userId: string, id: string) {
    const competition = await this.prisma.competition.findFirst({
      where: { id, ...VISIBLE },
      select: {
        id: true,
        name: true,
        status: true,
        startDate: true,
        registrationOpensAt: true,
        registrationClosesAt: true,
        maxParticipants: true,
        _count: { select: { participants: { where: { status: { in: COUNTED_STATUSES } } } } },
        participants: {
          where: { OR: [{ userId }, { partnerUserId: userId }], status: { in: ACTIVE_ENTRY_STATUSES } },
          select: { id: true },
          take: 1,
        },
        events: {
          where: { discipline: EventDiscipline.SINGLES },
          orderBy: [{ tableOrder: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            maxEntries: true,
            ...eventRulesSelect,
            _count: { select: { entries: { where: { status: { in: COUNTED_STATUSES } } } } },
            entries: { where: { userId }, select: { id: true, status: true } },
          },
        },
      },
    });
    if (!competition) throw new NotFoundException(t('errors.competitions.notFound'));

    // Registering twice is a no-op, not an error: retries stay safe.
    if (competition.participants.length > 0) return this.findOne(userId, id);

    if (!registrationIsOpen(competition)) {
      throw new ConflictException(t('errors.competitions.closed'));
    }
    const { maxParticipants } = competition;
    if (maxParticipants != null && competition._count.participants >= maxParticipants) {
      throw new ConflictException(t('errors.competitions.full'));
    }

    let event: (typeof competition.events)[number] | undefined;
    for (const candidate of competition.events) {
      const issues = await checkEntry(this.prisma, candidate, [userId], competition.startDate);
      if (issues.length === 0) {
        event = candidate;
        break;
      }
    }
    if (!event) throw new ConflictException(t('errors.competitions.notEligible'));
    if (event.maxEntries != null && event._count.entries >= event.maxEntries) {
      throw new ConflictException(t('errors.competitions.full'));
    }
    const previous = event.entries[0];
    if (previous?.status === RegistrationStatus.REJECTED) {
      throw new ConflictException(t('errors.competitions.rejected'));
    }
    // A withdrawn player signing up again reuses their entry.
    await this.prisma.competitionParticipant.upsert({
      where: { eventId_userId: { eventId: event.id, userId } },
      update: { status: RegistrationStatus.PENDING, registeredAt: new Date(), decidedAt: null, decidedById: null, seed: null },
      create: { competitionId: id, eventId: event.id, userId },
    });
    await this.notifications.notify(userId, registrationReceived(id, competition.name));
    return this.findOne(userId, id);
  }

  async unregister(userId: string, id: string) {
    const competition = await this.prisma.competition.findFirst({
      where: { id, ...VISIBLE },
      select: { id: true, status: true },
    });
    if (!competition) throw new NotFoundException(t('errors.competitions.notFound'));
    if (!entriesOpen(competition.status)) {
      throw new ConflictException(t('errors.competitions.started'));
    }
    await this.prisma.competitionParticipant.updateMany({
      where: { competitionId: id, userId, status: { in: ACTIVE_ENTRY_STATUSES } },
      data: { status: RegistrationStatus.WITHDRAWN, decidedAt: new Date(), decidedById: userId, seed: null },
    });
    return this.findOne(userId, id);
  }

  private toView(row: CompetitionRow, now: Date) {
    const {
      _count,
      participants,
      entryFee,
      maxParticipants,
      club,
      registrationOpensAt,
      registrationClosesAt,
      ...rest
    } = row;
    // Drafts never reach here (VISIBLE), so there is always a public status.
    const status = publicStatus(row.status) ?? 'UPCOMING';
    const spotsLeft =
      maxParticipants == null
        ? null
        : Math.max(0, maxParticipants - _count.participants);
    return {
      ...localize(rest),
      status,
      // Shown as badges; the app's three statuses stay unchanged.
      cancelled: row.status === CompetitionStatus.CANCELLED,
      interrupted: row.status === CompetitionStatus.INTERRUPTED,
      // The app reads the club's city as a plain name.
      club: club && { id: club.id, name: club.name, city: localize(club.city).name },
      entryFee,
      maxParticipants,
      participantsCount: _count.participants,
      spotsLeft,
      isRegistered: participants.length > 0,
      registrationStatus: participants[0]?.status ?? null,
      canRegister:
        registrationIsOpen({ status: row.status, registrationOpensAt, registrationClosesAt }, now) &&
        (spotsLeft === null || spotsLeft > 0),
    };
  }
}
