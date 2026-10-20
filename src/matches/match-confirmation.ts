import { MatchConfirmation, MatchValidation } from '@prisma/client';

// ---------------------------------------------------------------------------
// Result confirmation rules. A match counts (stats, streaks, rankings) only
// once every registered player who didn't record it has confirmed it; a single
// rejection means it never counts, for anyone.
// ---------------------------------------------------------------------------

export function computeValidation(
  p1: MatchConfirmation,
  p2: MatchConfirmation,
): MatchValidation {
  if (p1 === MatchConfirmation.REJECTED || p2 === MatchConfirmation.REJECTED) {
    return MatchValidation.REJECTED;
  }
  if (p1 === MatchConfirmation.PENDING || p2 === MatchConfirmation.PENDING) {
    return MatchValidation.PENDING;
  }
  return MatchValidation.VALIDATED;
}

export interface ConfirmableMatch {
  player1Id: string | null;
  player2Id: string | null;
  player1Confirmation: MatchConfirmation;
  player2Confirmation: MatchConfirmation;
  validation: MatchValidation;
}

/** Whether the match counts in `userId`'s stats (a referee's never does). */
export function countsFor(match: ConfirmableMatch, userId: string): boolean {
  if (match.validation !== MatchValidation.VALIDATED) return false;
  if (match.player1Id === userId) {
    return match.player1Confirmation === MatchConfirmation.CONFIRMED;
  }
  if (match.player2Id === userId) {
    return match.player2Confirmation === MatchConfirmation.CONFIRMED;
  }
  return false;
}

/** Initial status of a side: a guest isn't asked; a registered player is. */
export const sideConfirmation = (
  userId: string | null,
  isRecorder: boolean,
): MatchConfirmation =>
  !userId
    ? MatchConfirmation.NOT_REGISTERED
    : isRecorder
      ? MatchConfirmation.CONFIRMED
      : MatchConfirmation.PENDING;
