import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  addMonths,
  nextMembershipNumber,
  paymentStatus,
  remainingDue,
  renewalStart,
} from './membership-rules.js';
import { paymentReference, PaymentsService } from './payments.service.js';

const now = new Date('2026-09-28T12:00:00Z');
const period = (startedDaysAgo: number, months: number, paid: number, price: number) => {
  const startsAt = new Date(now.getTime() - startedDaysAgo * 86_400_000);
  return { startsAt, expiresAt: addMonths(startsAt, months), amountPaid: paid, fullyPaid: paid >= price };
};

describe('paymentStatus', () => {
  it.each([
    ['PAID', period(60, 12, 60000, 60000)],
    ['PARTIALLY_PAID', period(10, 12, 20000, 60000)],
    ['PENDING', period(5, 3, 0, 20000)],
    ['OVERDUE', period(45, 12, 0, 60000)],
    ['OVERDUE', period(45, 12, 10000, 60000)], // partial but past the grace period
    ['EXPIRED', period(120, 3, 20000, 20000)],
  ])('%s', (expected, p) => {
    expect(paymentStatus(p, now)).toBe(expected);
  });
});

describe('dates and numbers', () => {
  it('adds calendar months, clamping to the end of the month', () => {
    expect(addMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString().slice(0, 10)).toBe('2026-02-28');
    expect(addMonths(new Date('2026-09-28T00:00:00Z'), 12).toISOString().slice(0, 10)).toBe('2027-09-28');
  });

  it('renews from the end of a running period, or from today once expired', () => {
    const running = new Date('2026-12-31T00:00:00Z');
    expect(renewalStart(running, now)).toBe(running);
    expect(renewalStart(new Date('2026-01-01T00:00:00Z'), now).toISOString().slice(0, 10)).toBe('2026-09-28');
    expect(renewalStart(null, now).toISOString().slice(0, 10)).toBe('2026-09-28');
  });

  it('hands out the next numeric membership number', () => {
    expect(nextMembershipNumber([])).toBe('000001');
    expect(nextMembershipNumber(['000007', 'VIP-1', '000012'])).toBe('000013');
  });

  it('never reports a negative balance', () => {
    expect(remainingDue('60000', '20000')).toBe(40000);
    expect(remainingDue(100, 150)).toBe(0);
  });

  it('builds dated, readable payment references', () => {
    expect(paymentReference(new Date('2026-09-28T10:00:00Z'))).toMatch(/^PAY-20260928-[0-9A-F]{6}$/);
  });
});

describe('PaymentsService.record', () => {
  const tx = (overrides: Record<string, unknown>) => ({
    paymentMethod: { findUnique: vi.fn().mockResolvedValue({ key: 'CASH', active: true }) },
    $queryRaw: vi.fn().mockResolvedValue([]),
    membership: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    booking: { findUnique: vi.fn() },
    payment: { create: vi.fn(), aggregate: vi.fn() },
    ...overrides,
  });
  const service = new PaymentsService({} as never, { record: vi.fn() } as never);

  it("refuses a membership of another organization's club", async () => {
    const db = tx({
      membership: {
        findUnique: vi.fn().mockResolvedValue({ priceDue: 100, amountPaid: 0, currency: 'XOF', member: { userId: 'u', club: { organizationId: 'other-org' } } }),
      },
    });
    await expect(
      service.record('actor', 'my-org', { purpose: 'MEMBERSHIP', membershipId: 'm1', amount: 10, methodKey: 'CASH' }, db as never),
    ).rejects.toThrow('does not belong to this club');
  });

  it('refuses paying more than what remains due, after locking the period', async () => {
    const db = tx({
      membership: {
        findUnique: vi.fn().mockResolvedValue({ priceDue: 100, amountPaid: 80, currency: 'XOF', member: { userId: 'u', club: { organizationId: 'my-org' } } }),
      },
    });
    await expect(
      service.record('actor', 'my-org', { purpose: 'MEMBERSHIP', membershipId: 'm1', amount: 30, methodKey: 'CASH' }, db as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.$queryRaw).toHaveBeenCalled();
    expect(db.payment.create).not.toHaveBeenCalled();
  });

  it('refuses an inactive payment method', async () => {
    const db = tx({ paymentMethod: { findUnique: vi.fn().mockResolvedValue({ key: 'CARD', active: false }) } });
    await expect(
      service.record('actor', 'my-org', { purpose: 'OTHER', amount: 10, methodKey: 'CARD' }, db as never),
    ).rejects.toThrow('not available');
  });
});
