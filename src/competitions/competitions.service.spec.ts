import { CompetitionStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { effectiveStatus } from './competitions.service.js';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-09-21T12:00:00Z');
const at = (days: number) => new Date(now.getTime() + days * DAY);

describe('effectiveStatus', () => {
  it('is upcoming before the start date', () => {
    expect(
      effectiveStatus(
        { status: CompetitionStatus.UPCOMING, startDate: at(2), endDate: at(4) },
        now,
      ),
    ).toBe(CompetitionStatus.UPCOMING);
  });

  it('is ongoing between the start and end dates, even if stored as upcoming', () => {
    expect(
      effectiveStatus(
        { status: CompetitionStatus.UPCOMING, startDate: at(-1), endDate: at(1) },
        now,
      ),
    ).toBe(CompetitionStatus.ONGOING);
  });

  it('is completed after the end date', () => {
    expect(
      effectiveStatus(
        { status: CompetitionStatus.ONGOING, startDate: at(-5), endDate: at(-1) },
        now,
      ),
    ).toBe(CompetitionStatus.COMPLETED);
  });

  it('trusts a stored COMPLETED (closed early)', () => {
    expect(
      effectiveStatus(
        { status: CompetitionStatus.COMPLETED, startDate: at(-1), endDate: at(3) },
        now,
      ),
    ).toBe(CompetitionStatus.COMPLETED);
  });
});
