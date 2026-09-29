-- New match status, alone: PostgreSQL can't use an enum value in the
-- transaction that adds it.
ALTER TYPE "CompetitionMatchStatus" ADD VALUE 'POSTPONED';
