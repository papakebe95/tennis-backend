import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CompetitionStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { tournamentRegistered } from '../notifications/notification-messages.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { ListCompetitionsQueryDto } from './dto/list-competitions-query.dto.js';
import { t } from '../i18n/i18n.js';
import { localize } from '../i18n/localize.js';

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
    _count: { select: { participants: true } },
    // At most one row: this player's own registration.
    participants: { where: { userId }, select: { id: true }, take: 1 },
  }) satisfies Prisma.CompetitionSelect;

type CompetitionRow = Prisma.CompetitionGetPayload<{
  select: ReturnType<typeof competitionSelect>;
}>;

/**
 * The stored status is only trusted for COMPLETED (an organiser closing the
 * event early); otherwise the dates decide, so a seeded or forgotten row can
 * never show "Upcoming" for a tournament that already started.
 */
export function effectiveStatus(
  competition: { status: CompetitionStatus; startDate: Date; endDate: Date },
  now = new Date(),
): CompetitionStatus {
  if (competition.status === CompetitionStatus.COMPLETED) {
    return CompetitionStatus.COMPLETED;
  }
  if (now < competition.startDate) return CompetitionStatus.UPCOMING;
  if (now <= competition.endDate) return CompetitionStatus.ONGOING;
  return CompetitionStatus.COMPLETED;
}

// Live first, then what is coming soonest, then the most recent results.
const STATUS_ORDER: Record<CompetitionStatus, number> = {
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
      select: competitionSelect(userId),
    });
    const now = new Date();
    return rows
      .map((row) => this.toView(row, now))
      .filter((c) => !query.status || c.status === query.status)
      .sort((a, b) => {
        if (a.status !== b.status) {
          return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
        }
        // Featured events lead their group.
        if (a.featured !== b.featured) return a.featured ? -1 : 1;
        const byStart =
          new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
        return a.status === CompetitionStatus.COMPLETED ? -byStart : byStart;
      })
      .slice(0, query.limit ?? 20);
  }

  async findOne(userId: string, id: string) {
    const row = await this.prisma.competition.findUnique({
      where: { id },
      select: {
        ...competitionSelect(userId),
        participants: {
          orderBy: [{ seed: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
          take: 12,
          select: {
            id: true,
            userId: true,
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
        participants: participants.filter((p) => p.userId === userId),
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

  async register(userId: string, id: string) {
    const competition = await this.prisma.competition.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        status: true,
        startDate: true,
        endDate: true,
        maxParticipants: true,
        _count: { select: { participants: true } },
        participants: { where: { userId }, select: { id: true }, take: 1 },
      },
    });
    if (!competition) throw new NotFoundException(t('errors.competitions.notFound'));

    // Registering twice is a no-op, not an error: retries stay safe.
    if (competition.participants.length === 0) {
      if (effectiveStatus(competition) !== CompetitionStatus.UPCOMING) {
        throw new ConflictException(t('errors.competitions.closed'));
      }
      const { maxParticipants } = competition;
      if (
        maxParticipants != null &&
        competition._count.participants >= maxParticipants
      ) {
        throw new ConflictException(t('errors.competitions.full'));
      }
      await this.prisma.competitionParticipant.create({
        data: { competitionId: id, userId },
      });
      await this.notifications.notify(
        userId,
        tournamentRegistered(id, competition.name),
      );
    }
    return this.findOne(userId, id);
  }

  async unregister(userId: string, id: string) {
    const competition = await this.prisma.competition.findUnique({
      where: { id },
      select: { id: true, status: true, startDate: true, endDate: true },
    });
    if (!competition) throw new NotFoundException(t('errors.competitions.notFound'));
    if (effectiveStatus(competition) !== CompetitionStatus.UPCOMING) {
      throw new ConflictException(t('errors.competitions.started'));
    }
    await this.prisma.competitionParticipant.deleteMany({
      where: { competitionId: id, userId },
    });
    return this.findOne(userId, id);
  }

  private toView(row: CompetitionRow, now: Date) {
    const { _count, participants, entryFee, maxParticipants, club, ...rest } =
      row;
    const status = effectiveStatus(row, now);
    const spotsLeft =
      maxParticipants == null
        ? null
        : Math.max(0, maxParticipants - _count.participants);
    return {
      ...localize(rest),
      status,
      // The app reads the club's city as a plain name.
      club: club && { id: club.id, name: club.name, city: localize(club.city).name },
      entryFee,
      maxParticipants,
      participantsCount: _count.participants,
      spotsLeft,
      isRegistered: participants.length > 0,
      canRegister:
        status === CompetitionStatus.UPCOMING &&
        (spotsLeft === null || spotsLeft > 0),
    };
  }
}
