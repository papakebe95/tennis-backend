import { PlayerSide, RecordedMatchType } from '@prisma/client';
import { t } from '../i18n/i18n.js';

// ---------------------------------------------------------------------------
// Season ranking rules. Pure functions so the rules are easy to test and to
// show verbatim in the app ("How points work").
// ---------------------------------------------------------------------------

export const POINT_RULES: Record<
  RecordedMatchType,
  { win: number; loss: number }
> = {
  OFFICIAL: { win: 100, loss: 20 },
  FRIENDLY: { win: 50, loss: 10 },
  TRAINING: { win: 10, loss: 0 },
};

// A win over an unregistered guest is worth half — otherwise anyone could
// farm points against made-up opponents.
export const GUEST_MULTIPLIER = 0.5;

export const TIERS = [
  { key: 'ROOKIE', name: 'Rookie', min: 0 },
  { key: 'CONTENDER', name: 'Contender', min: 150 },
  { key: 'CHALLENGER', name: 'Challenger', min: 400 },
  { key: 'PRO', name: 'Pro', min: 800 },
  { key: 'CHAMPION', name: 'Champion', min: 1500 },
] as const;

export function matchPoints(
  type: RecordedMatchType,
  won: boolean,
  opponentRegistered: boolean,
): number {
  const base = won ? POINT_RULES[type].win : POINT_RULES[type].loss;
  return Math.round(opponentRegistered ? base : base * GUEST_MULTIPLIER);
}

export function tierFor(points: number) {
  let index = 0;
  TIERS.forEach((tier, i) => {
    if (points >= tier.min) index = i;
  });
  const current = TIERS[index];
  const next = TIERS[index + 1] ?? null;
  return {
    key: current.key,
    name: t(`tiers.${current.key}`),
    min: current.min,
    next: next
      ? { key: next.key, name: t(`tiers.${next.key}`), min: next.min }
      : null,
    // 0..1 through the current tier; 1 at the top tier.
    progress: next
      ? (points - current.min) / (next.min - current.min)
      : 1,
    pointsToNext: next ? next.min - points : 0,
  };
}

export interface RankedMatchRow {
  player1Id: string;
  player2Id: string | null;
  winnerSide: PlayerSide;
  matchType: RecordedMatchType;
  playedAt: Date;
}

export interface PlayerSeason {
  userId: string;
  points: number;
  wins: number;
  losses: number;
  // Newest first.
  results: ('WIN' | 'LOSS')[];
}

/** Aggregates decided matches into one season line per player. */
export function aggregateSeason(rows: RankedMatchRow[]): Map<string, PlayerSeason> {
  const players = new Map<string, PlayerSeason>();
  const line = (userId: string): PlayerSeason => {
    let entry = players.get(userId);
    if (!entry) {
      entry = { userId, points: 0, wins: 0, losses: 0, results: [] };
      players.set(userId, entry);
    }
    return entry;
  };

  const newestFirst = [...rows].sort(
    (a, b) => b.playedAt.getTime() - a.playedAt.getTime(),
  );
  for (const row of newestFirst) {
    const registeredOpponent = row.player2Id !== null;
    const sides: [string | null, boolean][] = [
      [row.player1Id, row.winnerSide === PlayerSide.PLAYER1],
      [row.player2Id, row.winnerSide === PlayerSide.PLAYER2],
    ];
    for (const [userId, won] of sides) {
      if (!userId) continue;
      const entry = line(userId);
      entry.points += matchPoints(row.matchType, won, registeredOpponent);
      if (won) entry.wins++;
      else entry.losses++;
      entry.results.push(won ? 'WIN' : 'LOSS');
    }
  }
  return players;
}

/** Standard competition ranking: equal points share a rank (1, 2, 2, 4). */
export function rankPlayers(players: PlayerSeason[]) {
  const sorted = [...players].sort(
    (a, b) => b.points - a.points || b.wins - a.wins,
  );
  let rank = 0;
  return sorted.map((player, i) => {
    const previous = sorted[i - 1];
    if (!previous || previous.points !== player.points) rank = i + 1;
    return { ...player, rank };
  });
}
