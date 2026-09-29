// ---------------------------------------------------------------------------
// Tennis score rules for tournament results, pure so they are unit-tested.
//
// A set is won at `gamesPerSet` with a two-game margin (6-4), at
// gamesPerSet+1 against gamesPerSet-1 (7-5), or at gamesPerSet+1 against
// gamesPerSet after a tiebreak (7-6, with the tiebreak points: first to 7,
// by two). The deciding set follows the event's `finalSet`:
// - TIEBREAK: like the others;
// - SUPER_TIEBREAK: a match tiebreak to 10 (by two), stored as a 1-0 set;
// - ADVANTAGE: played on until someone leads by two games (no tiebreak).
// A retirement keeps the score so far (the last set may be unfinished); a
// walkover has no score.
// ---------------------------------------------------------------------------

export type FinalSetRule = 'TIEBREAK' | 'SUPER_TIEBREAK' | 'ADVANTAGE';
export type Outcome = 'PLAYED' | 'RETIRED' | 'WALKOVER';
export type Side = 1 | 2;

export interface MatchRules {
  bestOf: number;
  gamesPerSet: number;
  finalSet: FinalSetRule;
}

export interface SetScore {
  side1: number;
  side2: number;
  tiebreak1?: number | null;
  tiebreak2?: number | null;
  superTiebreak?: boolean;
}

export type ScoreErrorCode =
  | 'NO_SETS'
  | 'TOO_MANY_SETS'
  | 'INVALID_SET'
  | 'TIEBREAK_REQUIRED'
  | 'INVALID_TIEBREAK'
  | 'SUPER_TIEBREAK_NOT_ALLOWED'
  | 'SET_AFTER_DECIDED'
  | 'MATCH_NOT_FINISHED'
  | 'MATCH_ALREADY_DECIDED'
  | 'WALKOVER_HAS_SETS'
  | 'LOSER_REQUIRED';

export interface ScoreError {
  code: ScoreErrorCode;
  /** 1-based set number, when the error is about one set. */
  set?: number;
}

export type ResultCheck =
  | { ok: true; winnerSide: Side; setsWon: [number, number] }
  | { ok: false; errors: ScoreError[] };

const setsToWin = (bestOf: number) => Math.ceil(bestOf / 2);

/** First to `target` points by two: a finished tiebreak's winner, or null. */
function tiebreakWinner(a: number, b: number, target: number): Side | null {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  if (hi < target || hi - lo < 2) return null;
  // Past the target, play stops as soon as the lead is two.
  if (hi > target && hi - lo !== 2) return null;
  return a > b ? 1 : 2;
}

type SetVerdict = { winner: Side } | { unfinished: true } | { error: ScoreErrorCode };

/**
 * Judges one set. `decider`: the set played at one set all (two all…).
 * `mayBeUnfinished`: the last set of a retirement.
 */
export function judgeSet(set: SetScore, rules: MatchRules, decider: boolean, mayBeUnfinished = false): SetVerdict {
  const g = rules.gamesPerSet;
  const { side1: a, side2: b } = set;
  if (![a, b].every((n) => Number.isInteger(n) && n >= 0)) return { error: 'INVALID_SET' };

  if (set.superTiebreak) {
    if (!decider || rules.finalSet !== 'SUPER_TIEBREAK') return { error: 'SUPER_TIEBREAK_NOT_ALLOWED' };
    const t1 = set.tiebreak1 ?? null;
    const t2 = set.tiebreak2 ?? null;
    if (t1 === null || t2 === null) return mayBeUnfinished ? { unfinished: true } : { error: 'TIEBREAK_REQUIRED' };
    const winner = tiebreakWinner(t1, t2, 10);
    if (!winner) return mayBeUnfinished && Math.max(t1, t2) <= 10 + 50 ? { unfinished: true } : { error: 'INVALID_TIEBREAK' };
    if (!(a + b === 1 && (winner === 1 ? a === 1 : b === 1))) return { error: 'INVALID_SET' };
    return { winner };
  }

  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  const leader: Side = a > b ? 1 : 2;
  const advantage = decider && rules.finalSet === 'ADVANTAGE';

  if (advantage) {
    if (hi >= g && hi - lo === 2) return { winner: leader };
    if (hi === g && lo <= g - 2) return { winner: leader };
    if (mayBeUnfinished && (hi < g || hi - lo < 2)) return { unfinished: true };
    return { error: 'INVALID_SET' };
  }

  if (hi === g && lo <= g - 2) return { winner: leader };
  if (hi === g + 1 && lo === g - 1) return { winner: leader };
  if (hi === g + 1 && lo === g) {
    const t1 = set.tiebreak1 ?? null;
    const t2 = set.tiebreak2 ?? null;
    if (t1 === null || t2 === null) return { error: 'TIEBREAK_REQUIRED' };
    const winner = tiebreakWinner(t1, t2, 7);
    if (!winner || winner !== leader) return { error: 'INVALID_TIEBREAK' };
    return { winner };
  }
  // Unfinished: nobody has won it yet and the score is still reachable.
  if (mayBeUnfinished && hi <= g && !(hi === g && lo <= g - 2)) return { unfinished: true };
  return { error: 'INVALID_SET' };
}

/**
 * Checks a whole result and names the winner. `loserSide` is the side that
 * retired or didn't show, for RETIRED and WALKOVER.
 */
export function checkResult(rules: MatchRules, outcome: Outcome, sets: readonly SetScore[], loserSide?: Side | null): ResultCheck {
  const need = setsToWin(rules.bestOf);
  if (outcome === 'WALKOVER') {
    if (sets.length) return { ok: false, errors: [{ code: 'WALKOVER_HAS_SETS' }] };
    if (!loserSide) return { ok: false, errors: [{ code: 'LOSER_REQUIRED' }] };
    return { ok: true, winnerSide: loserSide === 1 ? 2 : 1, setsWon: [0, 0] };
  }
  if (outcome === 'RETIRED' && !loserSide) return { ok: false, errors: [{ code: 'LOSER_REQUIRED' }] };
  if (outcome === 'PLAYED' && sets.length === 0) return { ok: false, errors: [{ code: 'NO_SETS' }] };
  if (sets.length > rules.bestOf) return { ok: false, errors: [{ code: 'TOO_MANY_SETS' }] };

  const won: [number, number] = [0, 0];
  const errors: ScoreError[] = [];
  for (const [i, set] of sets.entries()) {
    if (won[0] === need || won[1] === need) {
      errors.push({ code: 'SET_AFTER_DECIDED', set: i + 1 });
      break;
    }
    const decider = won[0] === need - 1 && won[1] === need - 1;
    const last = i === sets.length - 1;
    const verdict = judgeSet(set, rules, decider, outcome === 'RETIRED' && last);
    if ('error' in verdict) errors.push({ code: verdict.error, set: i + 1 });
    else if ('winner' in verdict) won[verdict.winner - 1]++;
  }
  if (errors.length) return { ok: false, errors };

  const decided = won[0] === need || won[1] === need;
  if (outcome === 'PLAYED') {
    if (!decided) return { ok: false, errors: [{ code: 'MATCH_NOT_FINISHED' }] };
    return { ok: true, winnerSide: won[0] === need ? 1 : 2, setsWon: won };
  }
  // Retirement: the match can't already be over.
  if (decided) return { ok: false, errors: [{ code: 'MATCH_ALREADY_DECIDED' }] };
  return { ok: true, winnerSide: loserSide === 1 ? 2 : 1, setsWon: won };
}

/** "6-4 3-6 [10-7]", "7-6(5)" from side 1's point of view. */
export function formatScore(sets: readonly SetScore[]): string {
  return sets
    .map((s) => {
      if (s.superTiebreak) return `[${s.tiebreak1 ?? 0}-${s.tiebreak2 ?? 0}]`;
      const tb = s.tiebreak1 != null && s.tiebreak2 != null ? `(${Math.min(s.tiebreak1, s.tiebreak2)})` : '';
      return `${s.side1}-${s.side2}${tb}`;
    })
    .join(' ');
}
