import { MatchConfirmation, PlayerSide, Prisma } from '@prisma/client';

// Names only: never expose email / msisdn of the other player.
const playerSelect = { id: true, firstname: true, lastname: true } as const;

export const matchInclude = {
  sets: { orderBy: { setNumber: 'asc' } },
  player1: { select: playerSelect },
  player2: { select: playerSelect },
  recordedBy: { select: playerSelect },
} satisfies Prisma.MatchInclude;

export type MatchWithRelations = Prisma.MatchGetPayload<{
  include: typeof matchInclude;
}>;

interface Person {
  id: string;
  firstname: string;
  lastname: string;
}

export const fullName = (p: Person) => `${p.firstname} ${p.lastname}`.trim();

// A match is stored from side 1's point of view (the recording player, or a
// referee's "me" side); player2 gets it flipped so that "me" is always them —
// the client never has to know who recorded it.
export function toMatchView(match: MatchWithRelations, viewerId: string) {
  const iAmPlayer1 = match.player2Id !== viewerId;
  const flip = <T>(a: T, b: T) => (iAmPlayer1 ? a : b);
  const recordedByMe = match.recordedById === viewerId;

  const side = (n: 1 | 2) => {
    const user = n === 1 ? match.player1 : match.player2;
    const guestName = n === 1 ? match.player1Name : match.player2Name;
    const userId = user?.id ?? null;
    const reason = n === 1 ? match.player1RejectReason : match.player2RejectReason;
    return {
      userId,
      name: user ? fullName(user) : (guestName ?? 'Guest'),
      confirmation: n === 1 ? match.player1Confirmation : match.player2Confirmation,
      respondedAt: n === 1 ? match.player1RespondedAt : match.player2RespondedAt,
      // Only the recorder and the player who wrote it see a rejection reason.
      rejectReason: recordedByMe || (userId !== null && userId === viewerId) ? reason : null,
    };
  };
  const me = side(iAmPlayer1 ? 1 : 2);
  const opponent = side(iAmPlayer1 ? 2 : 1);

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
    role: match.refereed && recordedByMe ? ('REFEREE' as const) : ('PLAYER' as const),
    me,
    opponent,
    referee:
      match.refereed && match.recordedBy
        ? { userId: match.recordedBy.id, name: fullName(match.recordedBy) }
        : null,
    recordedByMe,
    validation: match.validation,
    canRespond: me.userId === viewerId && me.confirmation === MatchConfirmation.PENDING,
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
    canDelete: recordedByMe,
  };
}

export type MatchView = ReturnType<typeof toMatchView>;
