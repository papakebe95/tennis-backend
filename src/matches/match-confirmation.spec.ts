import { MatchConfirmation as C, MatchValidation as V } from '@prisma/client';
import { computeValidation, countsFor } from './match-confirmation.js';

describe('computeValidation', () => {
  const all = [C.NOT_REGISTERED, C.PENDING, C.CONFIRMED, C.REJECTED];
  const expected = (p1: C, p2: C): V =>
    p1 === C.REJECTED || p2 === C.REJECTED
      ? V.REJECTED
      : p1 === C.PENDING || p2 === C.PENDING
        ? V.PENDING
        : V.VALIDATED;

  it.each(all.flatMap((p1) => all.map((p2) => [p1, p2] as const)))(
    '%s + %s',
    (p1, p2) => expect(computeValidation(p1, p2)).toBe(expected(p1, p2)),
  );

  it('spells out the key rows', () => {
    expect(computeValidation(C.CONFIRMED, C.NOT_REGISTERED)).toBe(V.VALIDATED);
    expect(computeValidation(C.NOT_REGISTERED, C.NOT_REGISTERED)).toBe(V.VALIDATED);
    expect(computeValidation(C.CONFIRMED, C.PENDING)).toBe(V.PENDING);
    expect(computeValidation(C.PENDING, C.REJECTED)).toBe(V.REJECTED);
  });
});

describe('countsFor', () => {
  const match = {
    player1Id: 'a',
    player2Id: 'b',
    player1Confirmation: C.CONFIRMED,
    player2Confirmation: C.CONFIRMED,
    validation: V.VALIDATED,
  };

  it('counts a validated match for both confirmed players', () => {
    expect(countsFor(match, 'a')).toBe(true);
    expect(countsFor(match, 'b')).toBe(true);
  });

  it("never counts for someone who didn't play (a referee)", () => {
    expect(countsFor(match, 'ref')).toBe(false);
  });

  it("doesn't count until validated", () => {
    expect(countsFor({ ...match, validation: V.PENDING }, 'a')).toBe(false);
    expect(countsFor({ ...match, validation: V.REJECTED }, 'a')).toBe(false);
  });
});
