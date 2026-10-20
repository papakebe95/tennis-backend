import { NotificationType } from '@prisma/client';
import {
  DEFAULT_LANG,
  INTL_LOCALES,
  t,
  type Lang,
  type MessageKey,
} from '../i18n/i18n.js';
import type { NotifyInput } from './notifications.service.js';

export type NotificationKey =
  | 'bookingConfirmed'
  | 'bookingCancelled'
  | 'purchaseRequestReceived'
  | 'purchaseRequestAccepted'
  | 'purchaseRequestDeclined'
  | 'tournamentRegistered'
  | 'registrationOpen'
  | 'niceWin'
  | 'courtReminder'
  | 'newGear'
  | 'welcome'
  | 'matchRecorded'
  | 'matchConfirmationRequested'
  | 'matchConfirmed'
  | 'matchRejected'
  | 'accessRequestSubmitted'
  | 'accessApproved'
  | 'accessRejected'
  | 'accessInfoRequested'
  | 'roleGranted'
  | 'registrationReceived'
  | 'registrationApproved'
  | 'registrationRejected'
  | 'registrationWaitlisted'
  | 'registrationWithdrawn'
  | 'tournamentCancelled'
  | 'tournamentInterrupted'
  | 'tournamentResumed'
  | 'drawPublished'
  | 'drawPlaced'
  | 'drawReplacedOut'
  | 'drawOpponentChanged'
  | 'tournamentMatchScheduled'
  | 'tournamentMatchResult'
  | 'tournamentMatchPostponed'
  | 'announcement'
  | 'membershipRequested'
  | 'membershipApproved'
  | 'membershipDeclined';

/** Language-neutral facts (JSON-safe), stored so the text can be re-rendered. */
export type NotificationParams = Record<string, string | number | boolean | null>;

// Club hours are treated as UTC everywhere (see CourtsService), so slot times
// are spoken in UTC too, or "18:00" would mean different things in the app and
// in its notifications.
const slotFormats = new Map<Lang, Intl.DateTimeFormat>();
const slot = (start: Date, lang: Lang) => {
  let format = slotFormats.get(lang);
  if (!format) {
    format = new Intl.DateTimeFormat(INTL_LOCALES[lang], {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'UTC',
    });
    slotFormats.set(lang, format);
  }
  return format.format(start);
};

/**
 * Words a notification in `lang` from its stored key and facts. Notifications
 * are rendered when they are read, so they follow the reader's language rather
 * than the language of whoever triggered them.
 */
export function renderNotification(
  key: NotificationKey,
  params: NotificationParams,
  lang: Lang,
): { title: string; body: string } {
  const text: Record<string, string | number | null> = {};
  for (const [name, value] of Object.entries(params)) {
    if (typeof value !== 'boolean') text[name] = value;
  }
  if (typeof params.start === 'string') {
    text.slot = slot(new Date(params.start), lang);
  }
  // Sub-keys of `key` to word the body with, when it has variants.
  let bodyKey = 'body';
  if (key === 'matchRecorded') {
    const outcome = t(
      `notifications.matchRecorded.${
        params.result === 'WIN'
          ? 'win'
          : params.result === 'LOSS'
            ? 'loss'
            : 'unfinished'
      }`,
      undefined,
      lang,
    );
    text.outcome = params.score ? `${outcome} ${params.score}` : outcome;
  }
  if (key === 'matchConfirmationRequested') {
    const variant = params.refereed ? 'referee' : 'player';
    const outcome = t(
      `notifications.matchConfirmationRequested.${variant}.${
        params.result === 'WIN' ? 'win' : params.result === 'LOSS' ? 'loss' : 'unfinished'
      }`,
      undefined,
      lang,
    );
    text.outcome = params.score ? `${outcome} ${params.score}` : outcome;
    bodyKey = `${variant}.body`;
  }
  if (key === 'matchConfirmed' && params.score) bodyKey = 'withScore';
  if (key === 'matchRejected' && params.reason) bodyKey = 'withReason';
  if (key === 'tournamentInterrupted' && typeof params.reasonCode === 'string') {
    const reason = t(`tournamentInterruptionReasons.${params.reasonCode}` as MessageKey, undefined, lang);
    text.reason = params.note ? `${reason} (${params.note})` : reason;
  }
  return {
    title: t(`notifications.${key}.title` as MessageKey, text, lang),
    body: t(`notifications.${key}.${bodyKey}` as MessageKey, text, lang),
  };
}

// `title`/`body` are also stored, in the default language, as the fallback for
// clients or rows that don't know about `key`.
const build = (
  type: NotificationType,
  key: NotificationKey,
  params: NotificationParams,
  route?: string,
): NotifyInput => ({
  type,
  key,
  params,
  route,
  ...renderNotification(key, params, DEFAULT_LANG),
});

interface BookingFacts {
  courtName: string;
  clubName: string;
  start: Date;
}

const bookingParams = (b: BookingFacts): NotificationParams => ({
  courtName: b.courtName,
  clubName: b.clubName,
  start: b.start.toISOString(),
});

export const bookingConfirmed = (b: BookingFacts): NotifyInput =>
  build(
    NotificationType.BOOKING,
    'bookingConfirmed',
    bookingParams(b),
    '/club/bookings',
  );

export const bookingCancelled = (b: BookingFacts): NotifyInput =>
  build(
    NotificationType.BOOKING,
    'bookingCancelled',
    bookingParams(b),
    '/club/bookings',
  );

export const purchaseRequestReceived = (
  productId: string,
  productTitle: string,
  buyerName: string,
): NotifyInput =>
  build(
    NotificationType.MARKETPLACE,
    'purchaseRequestReceived',
    { productTitle, buyerName },
    `/marketplace/product/${productId}`,
  );

export const purchaseRequestAnswered = (
  productId: string,
  productTitle: string,
  accepted: boolean,
): NotifyInput =>
  build(
    NotificationType.MARKETPLACE,
    accepted ? 'purchaseRequestAccepted' : 'purchaseRequestDeclined',
    { productTitle },
    `/marketplace/product/${productId}`,
  );

export const tournamentRegistered = (
  competitionId: string,
  name: string,
): NotifyInput =>
  build(
    NotificationType.TOURNAMENT,
    'tournamentRegistered',
    { name },
    `/tournaments/${competitionId}`,
  );

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

/**
 * Asks a player to confirm a match someone else recorded (their opponent, or a
 * referee). `result` and `sets` are from the notified player's point of view.
 */
export const matchConfirmationRequested = (
  matchId: string,
  recorderName: string,
  refereed: boolean,
  result: 'WIN' | 'LOSS' | null,
  sets: SetLine[],
): NotifyInput =>
  build(
    NotificationType.MATCH,
    'matchConfirmationRequested',
    { recorderName, refereed, result, score: scoreLine(sets) },
    `/play/match/${matchId}`,
  );

/** Tells the recorder a player confirmed; `sets` from the recorder's side. */
export const matchConfirmed = (matchId: string, playerName: string, sets: SetLine[]): NotifyInput =>
  build(NotificationType.MATCH, 'matchConfirmed', { playerName, score: scoreLine(sets) }, `/play/match/${matchId}`);

export const matchRejected = (matchId: string, playerName: string, reason: string | null): NotifyInput =>
  build(NotificationType.MATCH, 'matchRejected', { playerName, reason }, `/play/match/${matchId}`);

/**
 * No longer sent (new matches ask for confirmation instead); kept so stored
 * notifications still render. `result` and `sets` are from the notified
 * player's point of view.
 */
export const matchRecorded = (
  matchId: string,
  recorderName: string,
  result: 'WIN' | 'LOSS' | null,
  sets: SetLine[],
): NotifyInput =>
  build(
    NotificationType.MATCH,
    'matchRecorded',
    { recorderName, result, score: scoreLine(sets) },
    `/play/match/${matchId}`,
  );

// Back-office account notifications. No in-app route: the mobile app has no
// screen for them, and the back-office links them itself.
export const accessRequestSubmitted = (applicantName: string, roleName: string): NotifyInput =>
  build(NotificationType.SYSTEM, 'accessRequestSubmitted', { applicantName, roleName });

export const accessApproved = (roleName: string, scopeName: string): NotifyInput =>
  build(NotificationType.SYSTEM, 'accessApproved', { roleName, scopeName });

export const accessRejected = (roleName: string): NotifyInput =>
  build(NotificationType.SYSTEM, 'accessRejected', { roleName });

export const accessInfoRequested = (roleName: string): NotifyInput =>
  build(NotificationType.SYSTEM, 'accessInfoRequested', { roleName });

export const roleGranted = (roleName: string, scopeName: string): NotifyInput =>
  build(NotificationType.SYSTEM, 'roleGranted', { roleName, scopeName });

// Tournament entries and lifecycle; they open the tournament in the app.
const tournament = (key: NotificationKey, competitionId: string, params: NotificationParams) =>
  build(NotificationType.TOURNAMENT, key, params, `/tournaments/${competitionId}`);

export const registrationReceived = (competitionId: string, name: string): NotifyInput =>
  tournament('registrationReceived', competitionId, { name });

export type RegistrationOutcome = 'registrationApproved' | 'registrationRejected' | 'registrationWaitlisted' | 'registrationWithdrawn';

export const registrationDecided = (
  outcome: RegistrationOutcome,
  competitionId: string,
  name: string,
  eventName: string,
  reason?: string | null,
): NotifyInput => tournament(outcome, competitionId, { name, eventName, reason: reason ?? '' });

export const tournamentCancelled = (competitionId: string, name: string, reason: string): NotifyInput =>
  tournament('tournamentCancelled', competitionId, { name, reason });

/** `reasonCode` is an InterruptionReason, worded in the reader's language. */
export const tournamentInterrupted = (competitionId: string, name: string, reasonCode: string, note?: string | null): NotifyInput =>
  tournament('tournamentInterrupted', competitionId, { name, reasonCode, note: note ?? null });

export const tournamentResumed = (competitionId: string, name: string): NotifyInput =>
  tournament('tournamentResumed', competitionId, { name });

export type DrawNotificationKey = 'drawPublished' | 'drawPlaced' | 'drawReplacedOut' | 'drawOpponentChanged';

export const drawNotification = (
  key: DrawNotificationKey,
  competitionId: string,
  name: string,
  eventName: string,
  reason?: string | null,
): NotifyInput => tournament(key, competitionId, { name, eventName, reason: reason ?? '' });

export type MatchNotificationKey = 'matchScheduled' | 'matchResult' | 'matchPostponed';
const MATCH_KEYS: Record<MatchNotificationKey, NotificationKey> = {
  matchScheduled: 'tournamentMatchScheduled',
  matchResult: 'tournamentMatchResult',
  matchPostponed: 'tournamentMatchPostponed',
};

/** Tournament match news; `start` (ISO) is spoken as a slot ("Sat 11 Oct, 10:00"). */
export const matchNotification = (
  key: MatchNotificationKey,
  competitionId: string,
  name: string,
  eventName: string,
  params: Record<string, string>,
): NotifyInput => tournament(MATCH_KEYS[key], competitionId, { name, eventName, ...params });

/** An organizer's message: their own words, so no translation beyond the frame. */
export const announcement = (from: string, title: string, body: string, route?: string): NotifyInput =>
  build(NotificationType.SYSTEM, 'announcement', { from, title, body }, route);

/** To club staff: a player asked to join (back-office). */
export const membershipRequested = (playerName: string, clubName: string): NotifyInput =>
  build(NotificationType.SYSTEM, 'membershipRequested', { playerName, clubName });

/** To the player: the club answered their request. */
export const membershipDecided = (approved: boolean, clubName: string, reason?: string | null): NotifyInput =>
  build(NotificationType.SYSTEM, approved ? 'membershipApproved' : 'membershipDeclined', { clubName, reason: reason ?? '' });
