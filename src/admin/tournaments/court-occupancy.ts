import { CompetitionMatchStatus, Prisma, type PrismaClient } from '@prisma/client';

type Db = Pick<PrismaClient | Prisma.TransactionClient, 'competitionMatch'>;

/** Longest match we look back for when a block may overlap the window. */
const MAX_MATCH_MS = 10 * 60 * 60 * 1000;

export interface MatchBlock {
  matchId: string;
  courtId: string;
  start: Date;
  end: Date;
  competitionId: string;
  competitionName: string;
  eventName: string;
  participantIds: string[];
}

/** [aStart, aEnd) and [bStart, bEnd) share time. */
export const overlaps = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) => aStart < bEnd && bStart < aEnd;

/**
 * Tournament matches occupying courts during [from, to): each scheduled
 * match holds its court for its table's expected match length. Postponed
 * matches and byes hold nothing.
 */
export async function matchBlocks(
  db: Db,
  where: { courtIds?: string[]; competitionId?: string },
  from: Date,
  to: Date,
): Promise<MatchBlock[]> {
  const rows = await db.competitionMatch.findMany({
    where: {
      ...(where.courtIds ? { courtId: { in: where.courtIds } } : { courtId: { not: null } }),
      ...(where.competitionId ? { round: { competitionId: where.competitionId } } : {}),
      status: { notIn: [CompetitionMatchStatus.POSTPONED, CompetitionMatchStatus.BYE] },
      scheduledAt: { gte: new Date(from.getTime() - MAX_MATCH_MS), lt: to },
    },
    select: {
      id: true,
      courtId: true,
      scheduledAt: true,
      participant1Id: true,
      participant2Id: true,
      round: {
        select: {
          competitionId: true,
          competition: { select: { name: true } },
          event: { select: { name: true, matchDurationMinutes: true } },
        },
      },
    },
  });
  return rows
    .map((m) => ({
      matchId: m.id,
      courtId: m.courtId!,
      start: m.scheduledAt!,
      end: new Date(m.scheduledAt!.getTime() + m.round.event.matchDurationMinutes * 60_000),
      competitionId: m.round.competitionId,
      competitionName: m.round.competition.name,
      eventName: m.round.event.name,
      participantIds: [m.participant1Id, m.participant2Id].filter((id): id is string => !!id),
    }))
    .filter((b) => overlaps(b.start, b.end, from, to));
}
