import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MatchStatus, PlayerSide, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { matchRecorded } from '../notifications/notification-messages.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { CreateMatchDto } from './dto/create-match.dto.js';
import { ListMatchesQueryDto } from './dto/list-matches-query.dto.js';
import { matchInclude, toMatchView } from './matches.view.js';

// Matches where the user is either the recorder or the registered opponent.
const involving = (userId: string): Prisma.MatchWhereInput => ({
  OR: [{ player1Id: userId }, { player2Id: userId }],
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
    const where = involving(userId);

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

  async summary(userId: string) {
    const rows = await this.prisma.match.findMany({
      where: involving(userId),
      select: {
        player1Id: true,
        winnerSide: true,
        playSeconds: true,
        totalSeconds: true,
      },
      orderBy: { playedAt: 'desc' },
      take: 1000,
    });

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
    };
  }

  async findOne(userId: string, id: string) {
    const match = await this.prisma.match.findFirst({
      where: { id, ...involving(userId) },
      include: matchInclude,
    });
    if (!match) throw new NotFoundException('Match not found');
    return toMatchView(match, userId);
  }

  async create(userId: string, dto: CreateMatchDto) {
    const opponentName = dto.opponentName?.trim();
    if (!dto.opponentUserId && !opponentName) {
      throw new BadRequestException('Pick an opponent or type a name');
    }
    if (dto.opponentUserId === userId) {
      throw new BadRequestException("You can't play against yourself");
    }
    if (dto.opponentUserId) {
      const exists = await this.prisma.user.findUnique({
        where: { id: dto.opponentUserId },
        select: { id: true },
      });
      if (!exists) throw new BadRequestException('Opponent not found');
    }

    const startedAt = new Date(dto.startedAt);
    const endedAt = new Date(dto.endedAt);
    if (endedAt < startedAt) {
      throw new BadRequestException('The match cannot end before it starts');
    }
    // 2s of slack: the two clocks are read a moment apart on the client.
    if (dto.playSeconds > dto.totalSeconds + 2) {
      throw new BadRequestException(
        'Play time cannot be longer than the total duration',
      );
    }
    if (dto.status === 'COMPLETED' && !dto.winner) {
      throw new BadRequestException('A completed match needs a winner');
    }
    if (dto.status === 'COMPLETED' && dto.sets.length === 0) {
      throw new BadRequestException('A completed match needs a score');
    }

    // The client retries a failed save; the recording user can't have two
    // matches that started at the same instant, so treat that as a repeat.
    const existing = await this.prisma.match.findFirst({
      where: { player1Id: userId, startedAt },
      include: matchInclude,
    });
    if (existing) return toMatchView(existing, userId);

    const winnerSide = dto.winner
      ? dto.winner === 'ME'
        ? PlayerSide.PLAYER1
        : PlayerSide.PLAYER2
      : null;
    const winnerId =
      dto.winner === 'ME' ? userId : dto.winner === 'OPPONENT' ? (dto.opponentUserId ?? null) : null;

    const created = await this.prisma.match.create({
      data: {
        player1Id: userId,
        player2Id: dto.opponentUserId ?? null,
        player2Name: dto.opponentUserId ? null : (opponentName ?? null),
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

    // A registered opponent finds the match in their history; tell them.
    if (created.player2Id) {
      const theirView = toMatchView(created, created.player2Id);
      await this.notifications.notify(
        created.player2Id,
        matchRecorded(
          created.id,
          theirView.opponent.name,
          theirView.result,
          theirView.sets,
        ),
      );
    }
    return toMatchView(created, userId);
  }

  async remove(userId: string, id: string): Promise<void> {
    const match = await this.prisma.match.findFirst({
      where: { id, ...involving(userId) },
      select: { player1Id: true },
    });
    if (!match) throw new NotFoundException('Match not found');
    if (match.player1Id !== userId) {
      throw new ForbiddenException('Only the player who recorded it can delete a match');
    }
    await this.prisma.match.delete({ where: { id } });
  }
}
