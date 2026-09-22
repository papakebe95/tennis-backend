import { PlayerSide, RecordedMatchType } from '@prisma/client';
import {
  aggregateSeason,
  matchPoints,
  RankedMatchRow,
  rankPlayers,
  tierFor,
} from './ranking.js';

const row = (
  over: Partial<RankedMatchRow> & { day?: number } = {},
): RankedMatchRow => ({
  player1Id: 'a',
  player2Id: 'b',
  winnerSide: PlayerSide.PLAYER1,
  matchType: RecordedMatchType.OFFICIAL,
  playedAt: new Date(Date.UTC(2026, 2, over.day ?? 1)),
  ...over,
});

describe('matchPoints', () => {
  it('rewards official > friendly > training, and wins > losses', () => {
    expect(matchPoints('OFFICIAL', true, true)).toBe(100);
    expect(matchPoints('OFFICIAL', false, true)).toBe(20);
    expect(matchPoints('FRIENDLY', true, true)).toBe(50);
    expect(matchPoints('TRAINING', false, true)).toBe(0);
  });

  it('halves points against an unregistered guest', () => {
    expect(matchPoints('OFFICIAL', true, false)).toBe(50);
    expect(matchPoints('FRIENDLY', false, false)).toBe(5);
  });
});

describe('tierFor', () => {
  it('starts at Rookie with progress toward Contender', () => {
    const tier = tierFor(75);
    expect(tier.key).toBe('ROOKIE');
    expect(tier.next?.key).toBe('CONTENDER');
    expect(tier.progress).toBeCloseTo(0.5);
    expect(tier.pointsToNext).toBe(75);
  });

  it('promotes exactly at the threshold', () => {
    expect(tierFor(149).key).toBe('ROOKIE');
    expect(tierFor(150).key).toBe('CONTENDER');
  });

  it('tops out at Champion with a full bar', () => {
    const tier = tierFor(5000);
    expect(tier.key).toBe('CHAMPION');
    expect(tier.next).toBeNull();
    expect(tier.progress).toBe(1);
  });
});

describe('aggregateSeason', () => {
  it('scores both registered players, winner and loser', () => {
    const season = aggregateSeason([row()]);
    expect(season.get('a')).toMatchObject({ points: 100, wins: 1, losses: 0 });
    expect(season.get('b')).toMatchObject({ points: 20, wins: 0, losses: 1 });
  });

  it('gives guest matches half points to the recorder only', () => {
    const season = aggregateSeason([row({ player2Id: null })]);
    expect(season.get('a')?.points).toBe(50);
    expect(season.size).toBe(1);
  });

  it('lists results newest first', () => {
    const season = aggregateSeason([
      row({ day: 1, winnerSide: PlayerSide.PLAYER1 }),
      row({ day: 9, winnerSide: PlayerSide.PLAYER2 }),
    ]);
    expect(season.get('a')?.results).toEqual(['LOSS', 'WIN']);
  });
});

describe('rankPlayers', () => {
  it('shares a rank on equal points (1, 2, 2, 4)', () => {
    const ranked = rankPlayers(
      [100, 50, 50, 10].map((points, i) => ({
        userId: `u${i}`,
        points,
        wins: 0,
        losses: 0,
        results: [],
      })),
    );
    expect(ranked.map((p) => p.rank)).toEqual([1, 2, 2, 4]);
  });
});
