import { EntryType, Prisma, type PrismaClient } from '@prisma/client';
import { entryIssues, type EligibilityIssue, type EventRules, type PlayerFacts } from './eligibility.js';

type Db = Pick<PrismaClient | Prisma.TransactionClient, 'playerProfile' | 'classification'>;

/** Event fields eligibility needs, to spread into a Prisma select. */
export const eventRulesSelect = {
  discipline: true,
  gender: true,
  ageMin: true,
  ageMax: true,
  minClassification: { select: { rank: true } },
  maxClassification: { select: { rank: true } },
} satisfies Prisma.CompetitionEventSelect;

type EventRulesRow = Prisma.CompetitionEventGetPayload<{ select: typeof eventRulesSelect }>;

export const toRules = (event: EventRulesRow): EventRules => ({
  discipline: event.discipline,
  gender: event.gender,
  ageMin: event.ageMin,
  ageMax: event.ageMax,
  strongestRank: event.maxClassification?.rank ?? null,
  weakestRank: event.minClassification?.rank ?? null,
});

/** Eligibility facts of these players (players without a profile get nulls). */
export async function playerFacts(db: Db, userIds: readonly string[]): Promise<Map<string, PlayerFacts>> {
  const profiles = await db.playerProfile.findMany({
    where: { userId: { in: [...userIds] } },
    select: { userId: true, gender: true, birthDate: true, classification: { select: { rank: true } } },
  });
  const byUser = new Map(profiles.map((p) => [p.userId, p]));
  return new Map(
    userIds.map((id) => {
      const profile = byUser.get(id);
      return [
        id,
        {
          gender: profile?.gender ?? null,
          birthDate: profile?.birthDate ?? null,
          classificationRank: profile?.classification?.rank ?? null,
        },
      ];
    }),
  );
}

/** Rank of the weakest step of the scale ("NC"), assumed for unclassified players. */
export async function weakestScaleRank(db: Db): Promise<number> {
  const { _max } = await db.classification.aggregate({ _max: { rank: true } });
  return _max.rank ?? Number.MAX_SAFE_INTEGER;
}

/** Eligibility issues of an entry of `userIds` in an event starting on `on`. */
export async function checkEntry(
  db: Db,
  event: EventRulesRow,
  userIds: readonly string[],
  on: Date,
  entryType: EntryType = EntryType.DIRECT,
): Promise<EligibilityIssue[]> {
  const [facts, weakest] = await Promise.all([playerFacts(db, userIds), weakestScaleRank(db)]);
  return entryIssues(toRules(event), userIds.map((id) => facts.get(id)!), on, entryType, weakest);
}
