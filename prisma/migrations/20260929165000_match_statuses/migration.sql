-- New match statuses, in their own migration: PostgreSQL can't use an enum
-- value in the transaction that adds it.
ALTER TYPE "CompetitionMatchStatus" ADD VALUE 'PENDING';
ALTER TYPE "CompetitionMatchStatus" ADD VALUE 'READY';
