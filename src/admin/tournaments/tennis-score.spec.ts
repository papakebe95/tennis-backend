import { describe, expect, it } from 'vitest';
import { checkResult, formatScore, judgeSet, type MatchRules, type SetScore } from './tennis-score.js';

const bo3: MatchRules = { bestOf: 3, gamesPerSet: 6, finalSet: 'TIEBREAK' };
const stb: MatchRules = { ...bo3, finalSet: 'SUPER_TIEBREAK' };
const adv: MatchRules = { ...bo3, finalSet: 'ADVANTAGE' };
const s = (side1: number, side2: number, tiebreak1?: number, tiebreak2?: number): SetScore => ({ side1, side2, tiebreak1, tiebreak2 });
const errors = (r: ReturnType<typeof checkResult>) => (r.ok ? [] : r.errors.map((e) => e.code));

describe('judgeSet', () => {
  it('accepts normal set scores', () => {
    for (const [a, b] of [[6, 0], [6, 4], [4, 6], [7, 5], [5, 7]]) {
      expect(judgeSet(s(a, b), bo3, false)).toEqual({ winner: a > b ? 1 : 2 });
    }
  });

  it('refuses impossible scores', () => {
    for (const [a, b] of [[6, 5], [7, 4], [8, 6], [5, 3], [6, 6], [-1, 6]]) {
      expect(judgeSet(s(a, b), bo3, false)).toEqual({ error: 'INVALID_SET' });
    }
  });

  it('needs a valid tiebreak at 7-6', () => {
    expect(judgeSet(s(7, 6), bo3, false)).toEqual({ error: 'TIEBREAK_REQUIRED' });
    expect(judgeSet(s(7, 6, 7, 5), bo3, false)).toEqual({ winner: 1 });
    expect(judgeSet(s(7, 6, 12, 10), bo3, false)).toEqual({ winner: 1 });
    expect(judgeSet(s(7, 6, 7, 6), bo3, false)).toEqual({ error: 'INVALID_TIEBREAK' });
    expect(judgeSet(s(7, 6, 13, 10), bo3, false)).toEqual({ error: 'INVALID_TIEBREAK' });
    expect(judgeSet(s(6, 7, 7, 3), bo3, false)).toEqual({ error: 'INVALID_TIEBREAK' }); // wrong side
  });

  it('plays an advantage deciding set until a two-game lead', () => {
    expect(judgeSet(s(12, 10), adv, true)).toEqual({ winner: 1 });
    expect(judgeSet(s(7, 6, 7, 3), adv, true)).toEqual({ error: 'INVALID_SET' });
    expect(judgeSet(s(12, 10), adv, false)).toEqual({ error: 'INVALID_SET' }); // not the decider
  });

  it('allows a match tiebreak to 10 only as the decider of such events', () => {
    const mtb = { side1: 1, side2: 0, tiebreak1: 10, tiebreak2: 8, superTiebreak: true };
    expect(judgeSet(mtb, stb, true)).toEqual({ winner: 1 });
    expect(judgeSet({ ...mtb, tiebreak1: 13, tiebreak2: 11 }, stb, true)).toEqual({ winner: 1 });
    expect(judgeSet({ ...mtb, tiebreak1: 10, tiebreak2: 9 }, stb, true)).toEqual({ error: 'INVALID_TIEBREAK' });
    expect(judgeSet(mtb, stb, false)).toEqual({ error: 'SUPER_TIEBREAK_NOT_ALLOWED' });
    expect(judgeSet(mtb, bo3, true)).toEqual({ error: 'SUPER_TIEBREAK_NOT_ALLOWED' });
  });

  it('works with short sets', () => {
    const fast4: MatchRules = { bestOf: 3, gamesPerSet: 4, finalSet: 'TIEBREAK' };
    expect(judgeSet(s(4, 2), fast4, false)).toEqual({ winner: 1 });
    expect(judgeSet(s(5, 4, 7, 4), fast4, false)).toEqual({ winner: 1 });
    expect(judgeSet(s(6, 4), fast4, false)).toEqual({ error: 'INVALID_SET' });
  });
});

describe('checkResult', () => {
  it('names the winner of a finished match', () => {
    expect(checkResult(bo3, 'PLAYED', [s(6, 4), s(3, 6), s(7, 6, 7, 2)])).toEqual({ ok: true, winnerSide: 1, setsWon: [2, 1] });
    expect(checkResult(bo3, 'PLAYED', [s(2, 6), s(4, 6)])).toMatchObject({ ok: true, winnerSide: 2 });
    const mtb = { side1: 0, side2: 1, tiebreak1: 8, tiebreak2: 10, superTiebreak: true };
    expect(checkResult(stb, 'PLAYED', [s(6, 4), s(4, 6), mtb])).toMatchObject({ ok: true, winnerSide: 2 });
  });

  it('refuses unfinished, overlong or inconsistent results', () => {
    expect(errors(checkResult(bo3, 'PLAYED', []))).toEqual(['NO_SETS']);
    expect(errors(checkResult(bo3, 'PLAYED', [s(6, 4), s(3, 6)]))).toEqual(['MATCH_NOT_FINISHED']);
    expect(errors(checkResult(bo3, 'PLAYED', [s(6, 4), s(6, 3), s(6, 1)]))).toEqual(['SET_AFTER_DECIDED']);
    expect(errors(checkResult(bo3, 'PLAYED', [s(6, 4), s(6, 5)]))).toEqual(['INVALID_SET']);
    expect(errors(checkResult(bo3, 'PLAYED', [s(6, 4), s(4, 6), s(6, 1), s(6, 1)]))).toEqual(['TOO_MANY_SETS']);
  });

  it('keeps the score of a retirement and gives the match to the other side', () => {
    expect(checkResult(bo3, 'RETIRED', [s(6, 4), s(2, 3)], 1)).toEqual({ ok: true, winnerSide: 2, setsWon: [1, 0] });
    expect(checkResult(bo3, 'RETIRED', [], 2)).toMatchObject({ ok: true, winnerSide: 1 });
    expect(errors(checkResult(bo3, 'RETIRED', [s(6, 4), s(2, 3)]))).toEqual(['LOSER_REQUIRED']);
    expect(errors(checkResult(bo3, 'RETIRED', [s(6, 4), s(6, 3)], 1))).toEqual(['MATCH_ALREADY_DECIDED']);
    expect(errors(checkResult(bo3, 'RETIRED', [s(4, 2), s(6, 3)], 1))).toEqual(['INVALID_SET']); // only the last set may be unfinished
  });

  it('records a walkover without a score', () => {
    expect(checkResult(bo3, 'WALKOVER', [], 2)).toEqual({ ok: true, winnerSide: 1, setsWon: [0, 0] });
    expect(errors(checkResult(bo3, 'WALKOVER', [s(6, 0)], 2))).toEqual(['WALKOVER_HAS_SETS']);
  });

  it('handles best of one and best of five', () => {
    expect(checkResult({ ...bo3, bestOf: 1 }, 'PLAYED', [s(6, 3)])).toMatchObject({ ok: true, winnerSide: 1 });
    expect(checkResult({ ...bo3, bestOf: 5 }, 'PLAYED', [s(6, 3), s(3, 6), s(6, 3), s(6, 7, 3, 7), s(6, 4)])).toMatchObject({ ok: true, winnerSide: 1, setsWon: [3, 2] });
  });
});

describe('formatScore', () => {
  it('writes scores the usual way', () => {
    expect(formatScore([s(6, 4), s(6, 7, 5, 7), { side1: 1, side2: 0, tiebreak1: 10, tiebreak2: 7, superTiebreak: true }])).toBe('6-4 6-7(5) [10-7]');
  });
});

describe('court occupancy', () => {
  it('treats back-to-back slots as free and any overlap as taken', async () => {
    const { overlaps } = await import('./court-occupancy.js');
    const h = (n: number) => new Date(Date.UTC(2026, 9, 11, n));
    expect(overlaps(h(10), h(12), h(12), h(13))).toBe(false);
    expect(overlaps(h(10), h(12), h(11), h(13))).toBe(true);
    expect(overlaps(h(10), h(12), h(9), h(10))).toBe(false);
  });
});
