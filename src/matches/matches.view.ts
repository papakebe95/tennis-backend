import { PlayerSide, Prisma } from '@prisma/client';

// Names only: never expose email / msisdn of the other player.
const playerSelect = { id: true, firstname: true, lastname: true } as const;

export const matchInclude = {
  sets: { orderBy: { setNumber: 'asc' } },
  player1: { select: playerSelect },
  player2: { select: playerSelect },
} satisfies Prisma.MatchInclude;

export type MatchWithRelations = Prisma.MatchGetPayload<{
  include: typeof matchInclude;
}>;

interface Person {
  id: string;
  firstname: string;
  lastname: string;
}

const fullName = (p: Person) => `${p.firstname} ${p.lastname}`.trim();

// A match is stored from player1's (the recorder's) side; each viewer gets it
// flipped so that "me" is always them — the client never has to know who
// recorded it.
export function toMatchView(match: MatchWithRelations, viewerId: string) {
  const iAmPlayer1 = match.player1Id === viewerId;
  const flip = <T>(a: T, b: T) => (iAmPlayer1 ? a : b);

  const opponent = iAmPlayer1
    ? match.player2
      ? { userId: match.player2.id, name: fullName(match.player2) }
      : { userId: null, name: match.player2Name ?? 'Guest' }
    : { userId: match.player1.id, name: fullName(match.player1) };

  const mySide = iAmPlayer1 ? PlayerSide.PLAYER1 : PlayerSide.PLAYER2;
  const result: 'WIN' | 'LOSS' | null = match.winnerSide
    ? match.winnerSide === mySide
      ? 'WIN'
      : 'LOSS'
    : null;

  return {
    id: match.id,
    status: match.status,
    matchType: match.matchType,
    bestOf: match.bestOf,
    noAd: match.noAd,
    finalSet: match.finalSet,
    playedAt: match.playedAt,
    startedAt: match.startedAt,
    endedAt: match.endedAt,
    totalSeconds: match.totalSeconds,
    playSeconds: match.playSeconds,
    location: match.location,
    notes: match.notes,
    opponent,
    result,
    myPoints: flip(match.player1Points, match.player2Points),
    oppPoints: flip(match.player2Points, match.player1Points),
    sets: match.sets.map((s) => ({
      setNumber: s.setNumber,
      me: flip(s.player1Games, s.player2Games),
      opp: flip(s.player2Games, s.player1Games),
      superTiebreak: s.isSuperTiebreak,
      tiebreak:
        s.isTiebreak &&
        s.tiebreakPlayer1Points !== null &&
        s.tiebreakPlayer2Points !== null
          ? {
              me: flip(s.tiebreakPlayer1Points, s.tiebreakPlayer2Points),
              opp: flip(s.tiebreakPlayer2Points, s.tiebreakPlayer1Points),
            }
          : null,
    })),
    // Only the person who recorded it can delete it.
    canDelete: iAmPlayer1,
  };
}

export type MatchView = ReturnType<typeof toMatchView>;
