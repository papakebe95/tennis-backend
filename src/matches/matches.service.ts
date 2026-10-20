import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  MatchConfirmation,
  MatchStatus,
  MatchValidation,
  PlayerSide,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  matchConfirmationRequested,
  matchConfirmed,
  matchRejected,
} from '../notifications/notification-messages.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { CreateMatchDto } from './dto/create-match.dto.js';
import { ListMatchesQueryDto } from './dto/list-matches-query.dto.js';
import {
  computeValidation,
  countsFor,
  sideConfirmation,
} from './match-confirmation.js';
import { fullName, matchInclude, toMatchView } from './matches.view.js';
import { t } from '../i18n/i18n.js';

// Matches the user played in.
const playing = (userId: string): Prisma.MatchWhereInput => ({
  OR: [{ player1Id: userId }, { player2Id: userId }],
});

// Matches the user can see: played in, or recorded (refereed).
const visibleTo = (userId: string): Prisma.MatchWhereInput => ({
  OR: [{ recordedById: userId }, { player1Id: userId }, { player2Id: userId }],
});

// Matches the user still has to confirm or reject.
const awaitingAnswerFrom = (userId: string): Prisma.MatchWhereInput => ({
  OR: [
    { player1Id: userId, player1Confirmation: MatchConfirmation.PENDING },
    { player2Id: userId, player2Confirmation: MatchConfirmation.PENDING },
  ],
});

@Injectable()
export class MatchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(userId: string, query: ListMatchesQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where =
      query.role === 'PLAYER'
        ? playing(userId)
        : query.role === 'REFEREE'
          ? { recordedById: userId, refereed: true }
          : visibleTo(userId);

    const [total, rows] = await Promise.all([
      this.prisma.match.count({ where }),
      this.prisma.match.findMany({
        where,
        include: matchInclude,
        orderBy: { playedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      items: rows.map((m) => toMatchView(m, userId)),
      page,
      total,
      hasMore: page * pageSize < total,
    };
  }

  async pending(userId: string) {
    const rows = await this.prisma.match.findMany({
      where: awaitingAnswerFrom(userId),
      include: matchInclude,
      orderBy: { playedAt: 'desc' },
      take: 50,
    });
    return { items: rows.map((m) => toMatchView(m, userId)) };
  }

  async summary(userId: string) {
    const [all, pendingConfirmations, awaitingOthers] = await Promise.all([
      this.prisma.match.findMany({
        where: { ...playing(userId), validation: MatchValidation.VALIDATED },
        select: {
          player1Id: true,
          player2Id: true,
          player1Confirmation: true,
          player2Confirmation: true,
          validation: true,
          winnerSide: true,
          playSeconds: true,
          totalSeconds: true,
        },
        orderBy: { playedAt: 'desc' },
        take: 1000,
      }),
      this.prisma.match.count({ where: awaitingAnswerFrom(userId) }),
      this.prisma.match.count({
        where: { recordedById: userId, validation: MatchValidation.PENDING },
      }),
    ]);
    const rows = all.filter((row) => countsFor(row, userId));

    let wins = 0;
    let losses = 0;
    let playSeconds = 0;
    let totalSeconds = 0;
    // Current streak, newest match first (unfinished/no-winner matches are
    // skipped rather than breaking it).
    let streakType: 'WIN' | 'LOSS' | null = null;
    let streak = 0;
    let streakOpen = true;

    for (const row of rows) {
      playSeconds += row.playSeconds ?? 0;
      totalSeconds += row.totalSeconds ?? 0;
      if (!row.winnerSide) continue;
      const mySide =
        row.player1Id === userId ? PlayerSide.PLAYER1 : PlayerSide.PLAYER2;
      const won = row.winnerSide === mySide;
      if (won) wins++;
      else losses++;

      if (streakOpen) {
        const type = won ? 'WIN' : 'LOSS';
        if (streakType === null || streakType === type) {
          streakType = type;
          streak++;
        } else {
          streakOpen = false;
        }
      }
    }

    const decided = wins + losses;
    return {
      matches: rows.length,
      wins,
      losses,
      winRate: decided === 0 ? null : wins / decided,
      playSeconds,
      totalSeconds,
      streak: streakType ? { type: streakType, count: streak } : null,
      // Matches I have to answer, and matches I recorded still waiting on
      // someone else.
      pendingConfirmations,
      awaitingOthers,
    };
  }

  async findOne(userId: string, id: string) {
    const match = await this.prisma.match.findFirst({
      where: { id, ...visibleTo(userId) },
      include: matchInclude,
    });
    if (!match) throw new NotFoundException(t('errors.matches.notFound'));
    return toMatchView(match, userId);
  }

  async create(userId: string, dto: CreateMatchDto) {
    const refereeMode = dto.refereeMode === true;
    const playerName = dto.playerName?.trim();
    const opponentName = dto.opponentName?.trim();

    // Side 1 is the caller, or (referee mode) the player they picked.
    let player1Id: string | null = userId;
    if (refereeMode) {
      if (!dto.playerUserId === !playerName) {
        throw new BadRequestException(t('errors.matches.pickPlayer'));
      }
      if (!dto.opponentUserId === !opponentName) {
        throw new BadRequestException(t('errors.matches.pickOpponent'));
      }
      if (dto.playerUserId === userId || dto.opponentUserId === userId) {
        throw new BadRequestException(t('errors.matches.refereeIsPlayer'));
      }
      if (dto.playerUserId && dto.playerUserId === dto.opponentUserId) {
        throw new BadRequestException(t('errors.matches.samePlayer'));
      }
      player1Id = dto.playerUserId ?? null;
    } else {
      if (dto.playerUserId || dto.playerName) {
        throw new BadRequestException(
          t('errors.matches.refereeFieldsInPlayerMode'),
        );
      }
      if (!dto.opponentUserId && !opponentName) {
        throw new BadRequestException(t('errors.matches.pickOpponent'));
      }
      if (dto.opponentUserId === userId) {
        throw new BadRequestException(t('errors.matches.selfPlay'));
      }
    }
    const player2Id = dto.opponentUserId ?? null;
    const registered = [player1Id, player2Id].filter(
      (id): id is string => !!id && id !== userId,
    );
    if (registered.length) {
      const found = await this.prisma.user.findMany({
        where: { id: { in: registered } },
        select: { id: true },
      });
      if (found.length !== registered.length) {
        throw new BadRequestException(t('errors.matches.opponentNotFound'));
      }
    }

    const startedAt = new Date(dto.startedAt);
    const endedAt = new Date(dto.endedAt);
    if (endedAt < startedAt) {
      throw new BadRequestException(t('errors.matches.endBeforeStart'));
    }
    // 2s of slack: the two clocks are read a moment apart on the client.
    if (dto.playSeconds > dto.totalSeconds + 2) {
      throw new BadRequestException(t('errors.matches.playTimeTooLong'));
    }
    if (dto.status === 'COMPLETED' && !dto.winner) {
      throw new BadRequestException(t('errors.matches.needsWinner'));
    }
    if (dto.status === 'COMPLETED' && dto.sets.length === 0) {
      throw new BadRequestException(t('errors.matches.needsScore'));
    }

    // The client retries a failed save; the recording user can't have two
    // matches that started at the same instant, so treat that as a repeat.
    const existing = await this.prisma.match.findFirst({
      where: { recordedById: userId, startedAt },
      include: matchInclude,
    });
    if (existing) return toMatchView(existing, userId);

    const winnerSide = dto.winner
      ? dto.winner === 'ME'
        ? PlayerSide.PLAYER1
        : PlayerSide.PLAYER2
      : null;
    const winnerId =
      dto.winner === 'ME' ? player1Id : dto.winner === 'OPPONENT' ? player2Id : null;
    // A recording player is confirmed; everyone else registered is asked.
    const player1Confirmation = sideConfirmation(player1Id, player1Id === userId);
    const player2Confirmation = sideConfirmation(player2Id, false);

    const created = await this.prisma.match.create({
      data: {
        recordedById: userId,
        refereed: refereeMode,
        player1Id,
        player1Name: player1Id ? null : (playerName ?? null),
        player2Id,
        player2Name: player2Id ? null : (opponentName ?? null),
        player1Confirmation,
        player2Confirmation,
        validation: computeValidation(player1Confirmation, player2Confirmation),
        location: dto.location?.trim() || null,
        notes: dto.notes?.trim() || null,
        playedAt: startedAt,
        startedAt,
        endedAt,
        totalSeconds: dto.totalSeconds,
        playSeconds: dto.playSeconds,
        player1Points: dto.myPoints,
        player2Points: dto.oppPoints,
        bestOf: dto.bestOf,
        noAd: dto.noAd,
        finalSet: dto.finalSet,
        matchType: dto.matchType,
        status:
          dto.status === 'COMPLETED'
            ? MatchStatus.COMPLETED
            : MatchStatus.UNFINISHED,
        winnerSide,
        winnerId,
        sets: {
          create: dto.sets.map((s, index) => ({
            setNumber: index + 1,
            player1Games: s.me,
            player2Games: s.opp,
            isTiebreak: !!s.tiebreak,
            isSuperTiebreak: s.superTiebreak ?? false,
            tiebreakPlayer1Points: s.tiebreak?.me ?? null,
            tiebreakPlayer2Points: s.tiebreak?.opp ?? null,
          })),
        },
      },
      include: matchInclude,
    });

    // Each registered player who didn't record it is asked to confirm, from
    // their side of the score.
    const recorderName = created.recordedBy ? fullName(created.recordedBy) : '';
    const asked = [
      [created.player1Id, created.player1Confirmation],
      [created.player2Id, created.player2Confirmation],
    ] as const;
    for (const [playerId, confirmation] of asked) {
      if (!playerId || confirmation !== MatchConfirmation.PENDING) continue;
      const theirView = toMatchView(created, playerId);
      await this.notifications.notify(
        playerId,
        matchConfirmationRequested(
          created.id,
          recorderName,
          created.refereed,
          theirView.result,
          theirView.sets,
        ),
      );
    }
    return toMatchView(created, userId);
  }

  confirm(userId: string, id: string) {
    return this.answer(userId, id, MatchConfirmation.CONFIRMED, null);
  }

  reject(userId: string, id: string, reason?: string) {
    return this.answer(
      userId,
      id,
      MatchConfirmation.REJECTED,
      reason?.trim() || null,
    );
  }

  /** Records the caller's confirmation or rejection of their side. */
  private async answer(
    userId: string,
    id: string,
    confirmation: MatchConfirmation,
    reason: string | null,
  ) {
    const updated = await this.prisma.$transaction(async (tx) => {
      // Lock the row: a double tap, or both players answering at once, must
      // not answer twice or compute the validation from a stale side.
      await tx.$queryRaw`SELECT 1 FROM "Match" WHERE "id" = ${id} FOR UPDATE`;
      const match = await tx.match.findFirst({
        where: { id, ...visibleTo(userId) },
        select: {
          player1Id: true,
          player2Id: true,
          player1Confirmation: true,
          player2Confirmation: true,
        },
      });
      if (!match) throw new NotFoundException(t('errors.matches.notFound'));

      const side =
        match.player1Id === userId ? 1 : match.player2Id === userId ? 2 : null;
      const current =
        side === 1
          ? match.player1Confirmation
          : side === 2
            ? match.player2Confirmation
            : null;
      if (current !== MatchConfirmation.PENDING) {
        throw new ConflictException(t('errors.matches.alreadyAnswered'));
      }
      const respondedAt = new Date();
      const p1 = side === 1 ? confirmation : match.player1Confirmation;
      const p2 = side === 2 ? confirmation : match.player2Confirmation;
      return tx.match.update({
        where: { id },
        data: {
          ...(side === 1
            ? {
                player1Confirmation: confirmation,
                player1RespondedAt: respondedAt,
                player1RejectReason: reason,
              }
            : {
                player2Confirmation: confirmation,
                player2RespondedAt: respondedAt,
                player2RejectReason: reason,
              }),
          validation: computeValidation(p1, p2),
        },
        include: matchInclude,
      });
    });

    // The recorder hears back about every answer.
    if (updated.recordedById && updated.recordedById !== userId) {
      const mine = toMatchView(updated, userId).me;
      await this.notifications.notify(
        updated.recordedById,
        confirmation === MatchConfirmation.CONFIRMED
          ? matchConfirmed(
              updated.id,
              mine.name,
              toMatchView(updated, updated.recordedById).sets,
            )
          : matchRejected(updated.id, mine.name, reason),
      );
    }
    return toMatchView(updated, userId);
  }

  async remove(userId: string, id: string): Promise<void> {
    const match = await this.prisma.match.findFirst({
      where: { id, ...visibleTo(userId) },
      select: { recordedById: true },
    });
    if (!match) throw new NotFoundException(t('errors.matches.notFound'));
    if (match.recordedById !== userId) {
      throw new ForbiddenException(t('errors.matches.onlyRecorderDeletes'));
    }
    await this.prisma.match.delete({ where: { id } });
  }
}
