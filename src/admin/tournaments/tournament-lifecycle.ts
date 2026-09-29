import { CompetitionStatus } from '@prisma/client';

// ---------------------------------------------------------------------------
// Tournament lifecycle, kept pure so every rule is unit-tested.
//
//   DRAFT ─► REGISTRATION_OPEN ◄─► REGISTRATION_CLOSED ─► IN_PROGRESS ─► COMPLETED
//     │              │                     │                  │   ▲
//     └──────────────┴──────► CANCELLED ◄──┴──────────────────┤ INTERRUPTED
//
// INTERRUPTED is entered and left through interrupt/resume, not transitions.
// ---------------------------------------------------------------------------

const S = CompetitionStatus;

export const TRANSITIONS: Readonly<Record<CompetitionStatus, readonly CompetitionStatus[]>> = {
  DRAFT: [S.REGISTRATION_OPEN, S.CANCELLED],
  REGISTRATION_OPEN: [S.REGISTRATION_CLOSED, S.CANCELLED],
  REGISTRATION_CLOSED: [S.REGISTRATION_OPEN, S.IN_PROGRESS, S.CANCELLED],
  IN_PROGRESS: [S.COMPLETED, S.CANCELLED],
  INTERRUPTED: [S.CANCELLED],
  COMPLETED: [],
  CANCELLED: [],
};

/** Facts about the tournament that transition guards look at. */
export interface LifecycleFacts {
  startDate: Date;
  endDate: Date;
  registrationClosesAt: Date | null;
  eventCount: number;
  /** Events whose draw isn't PUBLISHED or LOCKED yet. */
  eventsWithoutPublishedDraw: number;
  /** Matches neither finished nor cancelled. */
  unfinishedMatches: number;
}

export type TransitionBlocker =
  | 'NOT_ALLOWED'
  | 'REASON_REQUIRED'
  | 'NO_EVENTS'
  | 'INVALID_DATES'
  | 'DRAWS_NOT_PUBLISHED'
  | 'MATCHES_UNFINISHED';

/** Why `from → to` can't happen now; empty when it can. */
export function transitionBlockers(
  from: CompetitionStatus,
  to: CompetitionStatus,
  facts: LifecycleFacts,
  reason?: string | null,
): TransitionBlocker[] {
  if (!TRANSITIONS[from].includes(to)) return ['NOT_ALLOWED'];
  const blockers: TransitionBlocker[] = [];
  if (to === S.CANCELLED && !reason?.trim()) blockers.push('REASON_REQUIRED');
  if (to === S.REGISTRATION_OPEN) {
    if (facts.eventCount === 0) blockers.push('NO_EVENTS');
    if (!datesValid(facts)) blockers.push('INVALID_DATES');
  }
  if (to === S.IN_PROGRESS && facts.eventsWithoutPublishedDraw > 0) blockers.push('DRAWS_NOT_PUBLISHED');
  if (to === S.COMPLETED && facts.unfinishedMatches > 0) blockers.push('MATCHES_UNFINISHED');
  return blockers;
}

export function datesValid(facts: Pick<LifecycleFacts, 'startDate' | 'endDate' | 'registrationClosesAt'>): boolean {
  if (facts.endDate < facts.startDate) return false;
  return !facts.registrationClosesAt || facts.registrationClosesAt <= facts.endDate;
}

/** Statuses the tournament can move to right now, with what blocks each. */
export function availableTransitions(from: CompetitionStatus, facts: LifecycleFacts) {
  return TRANSITIONS[from].map((to) => ({
    to,
    // The reason is asked for in the dialog; it isn't a blocker to show.
    blockers: transitionBlockers(from, to, facts, 'n/a'),
  }));
}

export const canInterrupt = (status: CompetitionStatus) => status === S.IN_PROGRESS;

/** Details (dates, rules, events) can be edited until the tournament ends. */
export const isEditable = (status: CompetitionStatus) =>
  status !== S.COMPLETED && status !== S.CANCELLED;

/** Entries can change until play starts. */
export const entriesOpen = (status: CompetitionStatus) =>
  status === S.DRAFT || status === S.REGISTRATION_OPEN || status === S.REGISTRATION_CLOSED;

// ---------------------------------------------------------------------------
// Player API compatibility: the mobile app knows UPCOMING / ONGOING /
// COMPLETED only.
// ---------------------------------------------------------------------------

export type PublicStatus = 'UPCOMING' | 'ONGOING' | 'COMPLETED';

/** null: not visible to players (draft). */
export function publicStatus(status: CompetitionStatus): PublicStatus | null {
  switch (status) {
    case S.DRAFT:
      return null;
    case S.REGISTRATION_OPEN:
    case S.REGISTRATION_CLOSED:
      return 'UPCOMING';
    case S.IN_PROGRESS:
    case S.INTERRUPTED:
      return 'ONGOING';
    case S.COMPLETED:
    case S.CANCELLED:
      return 'COMPLETED';
  }
}

export const PUBLIC_STATUS_FILTER: Readonly<Record<PublicStatus, CompetitionStatus[]>> = {
  UPCOMING: [S.REGISTRATION_OPEN, S.REGISTRATION_CLOSED],
  ONGOING: [S.IN_PROGRESS, S.INTERRUPTED],
  COMPLETED: [S.COMPLETED, S.CANCELLED],
};

/** Players can sign up now: registration open and inside its window. */
export function registrationIsOpen(
  competition: { status: CompetitionStatus; registrationOpensAt: Date | null; registrationClosesAt: Date | null },
  now = new Date(),
): boolean {
  return (
    competition.status === S.REGISTRATION_OPEN &&
    (!competition.registrationOpensAt || competition.registrationOpensAt <= now) &&
    (!competition.registrationClosesAt || now < competition.registrationClosesAt)
  );
}
