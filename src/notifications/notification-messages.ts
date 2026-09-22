import { NotificationType } from '@prisma/client';
import type { NotifyInput } from './notifications.service.js';

// Club hours are treated as UTC everywhere (see CourtsService), so slot times
// are spoken in UTC too, or "18:00" would mean different things in the app and
// in its notifications.
const slotFormat = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});

const slot = (start: Date) => slotFormat.format(start);

interface BookingFacts {
  courtName: string;
  clubName: string;
  start: Date;
}

export const bookingConfirmed = (b: BookingFacts): NotifyInput => ({
  type: NotificationType.BOOKING,
  title: 'Court booked',
  body: `${b.courtName} at ${b.clubName} · ${slot(b.start)}`,
  route: '/club/bookings',
});

export const bookingCancelled = (b: BookingFacts): NotifyInput => ({
  type: NotificationType.BOOKING,
  title: 'Booking cancelled',
  body: `${b.courtName} at ${b.clubName} · ${slot(b.start)} is free again.`,
  route: '/club/bookings',
});

export const purchaseRequestReceived = (
  productId: string,
  productTitle: string,
  buyerName: string,
): NotifyInput => ({
  type: NotificationType.MARKETPLACE,
  title: 'New purchase request',
  body: `${buyerName} wants your ${productTitle}.`,
  route: `/marketplace/product/${productId}`,
});

export const purchaseRequestAnswered = (
  productId: string,
  productTitle: string,
  accepted: boolean,
): NotifyInput => ({
  type: NotificationType.MARKETPLACE,
  title: accepted ? 'Request accepted' : 'Request declined',
  body: accepted
    ? `The seller accepted your request for ${productTitle}. Their contact is now visible.`
    : `Your request for ${productTitle} wasn't accepted.`,
  route: `/marketplace/product/${productId}`,
});

export const tournamentRegistered = (
  competitionId: string,
  name: string,
): NotifyInput => ({
  type: NotificationType.TOURNAMENT,
  title: "You're in!",
  body: `Your registration for ${name} is confirmed.`,
  route: `/tournaments/${competitionId}`,
});

interface SetLine {
  me: number;
  opp: number;
  superTiebreak: boolean;
  tiebreak: { me: number; opp: number } | null;
}

/** "6-4 3-6 [10-7]" — a match tiebreak shows its points, not its 1-0 games. */
export const scoreLine = (sets: SetLine[]) =>
  sets
    .map((s) =>
      s.superTiebreak && s.tiebreak
        ? `[${s.tiebreak.me}-${s.tiebreak.opp}]`
        : `${s.me}-${s.opp}`,
    )
    .join(' ');

/** `result` and `sets` are from the notified player's point of view. */
export const matchRecorded = (
  matchId: string,
  recorderName: string,
  result: 'WIN' | 'LOSS' | null,
  sets: SetLine[],
): NotifyInput => {
  const outcome =
    result === 'WIN' ? 'You won' : result === 'LOSS' ? 'You lost' : 'Unfinished';
  const score = scoreLine(sets);
  return {
    type: NotificationType.MATCH,
    title: 'Match added to your history',
    body: `${recorderName} recorded a match with you. ${outcome}${score ? ` ${score}` : ''}.`,
    route: `/play/match/${matchId}`,
  };
};
