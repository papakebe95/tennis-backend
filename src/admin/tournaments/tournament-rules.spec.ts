import { CompetitionStatus as S, EntryType, EventDiscipline, EventGender, Gender } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { entryIssues, playerIssues, sportAge, tableIssues, type EventRules, type TableFacts } from './eligibility.js';
import {
  availableTransitions,
  publicStatus,
  registrationIsOpen,
  transitionBlockers,
  type LifecycleFacts,
} from './tournament-lifecycle.js';

const facts = (over: Partial<LifecycleFacts> = {}): LifecycleFacts => ({
  startDate: new Date('2026-10-10'),
  endDate: new Date('2026-10-12'),
  registrationClosesAt: null,
  eventCount: 1,
  eventsWithoutPublishedDraw: 0,
  unfinishedMatches: 0,
  ...over,
});

describe('tournament lifecycle', () => {
  it('follows the allowed graph only', () => {
    expect(transitionBlockers(S.DRAFT, S.REGISTRATION_OPEN, facts())).toEqual([]);
    expect(transitionBlockers(S.DRAFT, S.IN_PROGRESS, facts())).toEqual(['NOT_ALLOWED']);
    expect(transitionBlockers(S.COMPLETED, S.REGISTRATION_OPEN, facts())).toEqual(['NOT_ALLOWED']);
    expect(transitionBlockers(S.REGISTRATION_CLOSED, S.REGISTRATION_OPEN, facts())).toEqual([]);
  });

  it('needs events and consistent dates to open registration', () => {
    expect(transitionBlockers(S.DRAFT, S.REGISTRATION_OPEN, facts({ eventCount: 0 }))).toEqual(['NO_EVENTS']);
    expect(
      transitionBlockers(S.DRAFT, S.REGISTRATION_OPEN, facts({ endDate: new Date('2026-10-01') })),
    ).toEqual(['INVALID_DATES']);
    expect(
      transitionBlockers(S.DRAFT, S.REGISTRATION_OPEN, facts({ registrationClosesAt: new Date('2026-10-20') })),
    ).toEqual(['INVALID_DATES']);
  });

  it('needs every draw published to start and every match finished to complete', () => {
    expect(
      transitionBlockers(S.REGISTRATION_CLOSED, S.IN_PROGRESS, facts({ eventsWithoutPublishedDraw: 2 })),
    ).toEqual(['DRAWS_NOT_PUBLISHED']);
    expect(transitionBlockers(S.IN_PROGRESS, S.COMPLETED, facts({ unfinishedMatches: 1 }))).toEqual([
      'MATCHES_UNFINISHED',
    ]);
  });

  it('requires a reason to cancel, even an interrupted tournament', () => {
    expect(transitionBlockers(S.IN_PROGRESS, S.CANCELLED, facts(), '  ')).toEqual(['REASON_REQUIRED']);
    expect(transitionBlockers(S.INTERRUPTED, S.CANCELLED, facts(), 'Flooded courts')).toEqual([]);
  });

  it('lists available transitions with their blockers but no reason blocker', () => {
    const options = availableTransitions(S.REGISTRATION_CLOSED, facts({ eventsWithoutPublishedDraw: 1 }));
    expect(options).toEqual([
      { to: S.REGISTRATION_OPEN, blockers: [] },
      { to: S.IN_PROGRESS, blockers: ['DRAWS_NOT_PUBLISHED'] },
      { to: S.CANCELLED, blockers: [] },
    ]);
  });

  it('maps to the player API statuses and hides drafts', () => {
    expect(publicStatus(S.DRAFT)).toBeNull();
    expect(publicStatus(S.REGISTRATION_CLOSED)).toBe('UPCOMING');
    expect(publicStatus(S.INTERRUPTED)).toBe('ONGOING');
    expect(publicStatus(S.CANCELLED)).toBe('COMPLETED');
  });

  it('opens registration only inside its window', () => {
    const now = new Date('2026-10-05T12:00:00Z');
    const base = { status: S.REGISTRATION_OPEN, registrationOpensAt: null, registrationClosesAt: null };
    expect(registrationIsOpen(base, now)).toBe(true);
    expect(registrationIsOpen({ ...base, registrationClosesAt: new Date('2026-10-05T11:00:00Z') }, now)).toBe(false);
    expect(registrationIsOpen({ ...base, registrationOpensAt: new Date('2026-10-06') }, now)).toBe(false);
    expect(registrationIsOpen({ ...base, status: S.REGISTRATION_CLOSED }, now)).toBe(false);
  });
});

// Ranks on the seeded scale: 15 = 11, 15/5 = 16, 30 = 17, 30/5 = 22, NC = 24.
const thirties: EventRules = {
  discipline: EventDiscipline.SINGLES,
  gender: EventGender.MEN,
  ageMin: null,
  ageMax: null,
  strongestRank: 17,
  weakestRank: 22,
};
const on = new Date('2026-10-10');
const man = (classificationRank: number | null) => ({ gender: Gender.MALE, birthDate: new Date('1990-05-01'), classificationRank });

describe('eligibility', () => {
  it('admits players inside the classification window', () => {
    expect(playerIssues(thirties, man(17), on)).toEqual([]);
    expect(playerIssues(thirties, man(22), on)).toEqual([]);
    expect(playerIssues(thirties, man(16), on)).toEqual(['CLASSIFICATION_TOO_STRONG']);
    expect(playerIssues(thirties, man(23), on)).toEqual(['CLASSIFICATION_TOO_WEAK']);
  });

  it('treats unclassified players as the weakest step', () => {
    expect(playerIssues(thirties, man(null), on, EntryType.DIRECT, 24)).toEqual(['CLASSIFICATION_TOO_WEAK']);
    expect(playerIssues({ ...thirties, weakestRank: null }, man(null), on, EntryType.DIRECT, 24)).toEqual([]);
  });

  it('lets qualifiers from a lower table in, but never players who are too strong', () => {
    const fifteens = { ...thirties, strongestRank: 11, weakestRank: 16 };
    expect(playerIssues(fifteens, man(20), on, EntryType.QUALIFIER)).toEqual([]);
    expect(playerIssues(fifteens, man(5), on, EntryType.QUALIFIER)).toEqual(['CLASSIFICATION_TOO_STRONG']);
  });

  it('checks gender and tennis age (age reached during the year)', () => {
    expect(playerIssues(thirties, { ...man(18), gender: Gender.FEMALE }, on)).toEqual(['GENDER']);
    expect(playerIssues(thirties, { ...man(18), gender: null }, on)).toEqual(['GENDER_UNKNOWN']);
    expect(sportAge(new Date('2012-12-31'), new Date('2026-01-02'))).toBe(14);
    const u14 = { ...thirties, gender: EventGender.OPEN, ageMax: 14, strongestRank: null, weakestRank: null };
    expect(playerIssues(u14, { ...man(null), birthDate: new Date('2012-12-31') }, on)).toEqual([]);
    expect(playerIssues(u14, { ...man(null), birthDate: new Date('2011-01-01') }, on)).toEqual(['TOO_OLD']);
    expect(playerIssues(u14, { ...man(null), birthDate: null }, on)).toEqual(['AGE_UNKNOWN']);
    const seniors = { ...u14, ageMax: null, ageMin: 45 };
    expect(playerIssues(seniors, man(null), on)).toEqual(['TOO_YOUNG']);
  });

  it('requires a man and a woman in mixed doubles', () => {
    const mixed = { ...thirties, discipline: EventDiscipline.DOUBLES, gender: EventGender.MIXED, strongestRank: null, weakestRank: null };
    expect(entryIssues(mixed, [man(18), { ...man(18), gender: Gender.FEMALE }], on)).toEqual([]);
    expect(entryIssues(mixed, [man(18), man(19)], on)).toEqual(['MIXED_PAIR']);
  });
});

const table = (over: Partial<TableFacts> & { id: string }): TableFacts => ({
  name: over.id,
  tableOrder: 0,
  qualifiesIntoEventId: null,
  qualifierCount: 0,
  strongestRank: null,
  weakestRank: null,
  ...over,
});

describe('successive tables', () => {
  it('accepts a chain of lower tables feeding higher ones', () => {
    expect(
      tableIssues([
        table({ id: '30s', tableOrder: 0, qualifiesIntoEventId: '15s', qualifierCount: 2, strongestRank: 17, weakestRank: 22 }),
        table({ id: '15s', tableOrder: 1, qualifiesIntoEventId: 'final', qualifierCount: 2 }),
        table({ id: 'final', tableOrder: 2 }),
      ]),
    ).toEqual([]);
  });

  it('rejects loops, missing targets and inconsistent qualifier counts', () => {
    expect(
      tableIssues([
        table({ id: 'a', tableOrder: 1, qualifiesIntoEventId: 'b', qualifierCount: 1 }),
        table({ id: 'b', tableOrder: 1, qualifiesIntoEventId: 'a', qualifierCount: 0 }),
        table({ id: 'c', qualifiesIntoEventId: 'gone', qualifierCount: 1 }),
        table({ id: 'd', qualifierCount: 3 }),
        table({ id: 'e', strongestRank: 20, weakestRank: 10 }),
      ]),
    ).toEqual([
      { code: 'TARGET_NOT_HIGHER', eventId: 'a' },
      { code: 'TARGET_NOT_HIGHER', eventId: 'b' },
      { code: 'TARGET_WITHOUT_QUALIFIERS', eventId: 'b' },
      { code: 'TARGET_MISSING', eventId: 'c' },
      { code: 'QUALIFIERS_WITHOUT_TARGET', eventId: 'd' },
      { code: 'WINDOW_INVERTED', eventId: 'e' },
    ]);
  });
});

describe('registration decisions', () => {
  // The back-office mirrors this table (DECISIONS_FROM) to show only valid actions.
  it('only moves entries along the allowed paths', async () => {
    const { DECISIONS } = await import('./registrations.service.js');
    expect(DECISIONS.approve.from).toEqual(['PENDING', 'WAITLISTED']);
    expect(DECISIONS.reject.from).toEqual(['PENDING', 'WAITLISTED']);
    expect(DECISIONS.waitlist.from).toEqual(['PENDING', 'APPROVED']);
    expect(DECISIONS.withdraw.from).toEqual(['PENDING', 'APPROVED', 'WAITLISTED']);
    expect(Object.values(DECISIONS).every((d) => !d.from.includes('REJECTED') && !d.from.includes('WITHDRAWN'))).toBe(true);
  });
});
