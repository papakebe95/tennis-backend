import { EntryType, EventDiscipline, EventGender, Gender } from '@prisma/client';

// ---------------------------------------------------------------------------
// Who may enter an event, and whether a tournament's tables fit together.
// Pure, so the rules are unit-tested; the services load the facts.
// ---------------------------------------------------------------------------

export interface EventRules {
  discipline: EventDiscipline;
  gender: EventGender;
  ageMin: number | null;
  ageMax: number | null;
  /** Classification window as ranks (1 = strongest): strongest and weakest admitted. */
  strongestRank: number | null;
  weakestRank: number | null;
}

export interface PlayerFacts {
  gender: Gender | null;
  birthDate: Date | null;
  /** null = not classified, treated as the weakest step. */
  classificationRank: number | null;
}

export type EligibilityIssue =
  | 'GENDER'
  | 'GENDER_UNKNOWN'
  | 'AGE_UNKNOWN'
  | 'TOO_YOUNG'
  | 'TOO_OLD'
  | 'CLASSIFICATION_TOO_STRONG'
  | 'CLASSIFICATION_TOO_WEAK'
  | 'MIXED_PAIR';

/**
 * Tennis age: the age reached during the tournament's calendar year, so a
 * player's category doesn't change mid-season.
 */
export const sportAge = (birthDate: Date, on: Date) => on.getUTCFullYear() - birthDate.getUTCFullYear();

/**
 * Checks one player against an event. Players coming up from a lower table
 * (qualifiers, lucky losers) or invited (wildcards) are by definition outside
 * the event's classification floor, so "too weak" doesn't apply to them.
 */
export function playerIssues(
  rules: EventRules,
  player: PlayerFacts,
  on: Date,
  entryType: EntryType = EntryType.DIRECT,
  weakestScaleRank = Number.MAX_SAFE_INTEGER,
): EligibilityIssue[] {
  const issues: EligibilityIssue[] = [];

  const wanted = rules.gender === EventGender.MEN ? Gender.MALE : rules.gender === EventGender.WOMEN ? Gender.FEMALE : null;
  if (wanted) {
    if (!player.gender) issues.push('GENDER_UNKNOWN');
    else if (player.gender !== wanted) issues.push('GENDER');
  }

  if (rules.ageMin !== null || rules.ageMax !== null) {
    if (!player.birthDate) issues.push('AGE_UNKNOWN');
    else {
      const age = sportAge(player.birthDate, on);
      if (rules.ageMin !== null && age < rules.ageMin) issues.push('TOO_YOUNG');
      if (rules.ageMax !== null && age > rules.ageMax) issues.push('TOO_OLD');
    }
  }

  const rank = player.classificationRank ?? weakestScaleRank;
  if (rules.strongestRank !== null && rank < rules.strongestRank) issues.push('CLASSIFICATION_TOO_STRONG');
  const exempt = entryType === EntryType.QUALIFIER || entryType === EntryType.LUCKY_LOSER || entryType === EntryType.WILDCARD;
  if (!exempt && rules.weakestRank !== null && rank > rules.weakestRank) issues.push('CLASSIFICATION_TOO_WEAK');
  return issues;
}

/** Issues of an entry: each player's, plus the pair rule of mixed doubles. */
export function entryIssues(
  rules: EventRules,
  players: readonly PlayerFacts[],
  on: Date,
  entryType: EntryType = EntryType.DIRECT,
  weakestScaleRank?: number,
): EligibilityIssue[] {
  const issues = new Set(players.flatMap((p) => playerIssues(rules, p, on, entryType, weakestScaleRank)));
  if (rules.discipline === EventDiscipline.DOUBLES && rules.gender === EventGender.MIXED && players.length === 2) {
    const [a, b] = players;
    if (!a.gender || !b.gender) issues.add('GENDER_UNKNOWN');
    else if (a.gender === b.gender) issues.add('MIXED_PAIR');
  }
  return [...issues];
}

// ---------------------------------------------------------------------------
// Successive tables
// ---------------------------------------------------------------------------

export interface TableFacts {
  id: string;
  name: string;
  tableOrder: number;
  qualifiesIntoEventId: string | null;
  qualifierCount: number;
  strongestRank: number | null;
  weakestRank: number | null;
}

export type TableIssue =
  | { code: 'TARGET_MISSING'; eventId: string }
  | { code: 'TARGET_NOT_HIGHER'; eventId: string }
  | { code: 'QUALIFIERS_WITHOUT_TARGET'; eventId: string }
  | { code: 'TARGET_WITHOUT_QUALIFIERS'; eventId: string }
  | { code: 'WINDOW_INVERTED'; eventId: string };

/**
 * Structural problems in a tournament's tables. A lower table must feed a
 * table that comes after it (so chains can't loop) and send at least one
 * player; a window must not be upside down.
 */
export function tableIssues(tables: readonly TableFacts[]): TableIssue[] {
  const byId = new Map(tables.map((table) => [table.id, table]));
  const issues: TableIssue[] = [];
  for (const table of tables) {
    if (table.strongestRank !== null && table.weakestRank !== null && table.strongestRank > table.weakestRank) {
      issues.push({ code: 'WINDOW_INVERTED', eventId: table.id });
    }
    if (!table.qualifiesIntoEventId) {
      if (table.qualifierCount > 0) issues.push({ code: 'QUALIFIERS_WITHOUT_TARGET', eventId: table.id });
      continue;
    }
    const target = byId.get(table.qualifiesIntoEventId);
    if (!target) issues.push({ code: 'TARGET_MISSING', eventId: table.id });
    else if (target.tableOrder <= table.tableOrder) issues.push({ code: 'TARGET_NOT_HIGHER', eventId: table.id });
    if (table.qualifierCount < 1) issues.push({ code: 'TARGET_WITHOUT_QUALIFIERS', eventId: table.id });
  }
  return issues;
}
