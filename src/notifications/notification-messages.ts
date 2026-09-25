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
  | 'matchRecorded';

/** Language-neutral facts (JSON-safe), stored so the text can be re-rendered. */
export type NotificationParams = Record<string, string | number | null>;

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
  const text: Record<string, string | number | null> = { ...params };
  if (typeof params.start === 'string') {
    text.slot = slot(new Date(params.start), lang);
  }
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
  return {
    title: t(`notifications.${key}.title` as MessageKey, text, lang),
    body: t(`notifications.${key}.body` as MessageKey, text, lang),
  };
}

// `title`/`body` are also stored, in the default language, as the fallback for
// clients or rows that don't know about `key`.
const build = (
  type: NotificationType,
  key: NotificationKey,
  params: NotificationParams,
  route: string,
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

/** `result` and `sets` are from the notified player's point of view. */
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
