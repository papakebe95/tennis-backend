import type { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Membership rules, kept pure for testing.
//
// A member's payment status comes from their current period:
//   EXPIRED         the period has ended
//   PAID            fully paid
//   OVERDUE         not fully paid, and started more than GRACE_DAYS ago
//   PARTIALLY_PAID  something paid, within the grace period
//   PENDING         nothing paid yet, within the grace period
// ---------------------------------------------------------------------------

export const PAYMENT_STATUSES = ['PAID', 'PARTIALLY_PAID', 'PENDING', 'EXPIRED', 'OVERDUE'] as const;
export type MembershipPaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Days after a period starts before an unpaid membership is overdue. */
export const GRACE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PeriodFacts {
  startsAt: Date;
  expiresAt: Date;
  amountPaid: Prisma.Decimal | number | string;
  fullyPaid: boolean;
}

export function paymentStatus(period: PeriodFacts, now = new Date()): MembershipPaymentStatus {
  if (period.expiresAt < now) return 'EXPIRED';
  if (period.fullyPaid) return 'PAID';
  if (period.startsAt.getTime() + GRACE_DAYS * DAY_MS < now.getTime()) return 'OVERDUE';
  return Number(period.amountPaid) > 0 ? 'PARTIALLY_PAID' : 'PENDING';
}

/** The same rules as a filter on Membership, for list queries. */
export function paymentStatusWhere(status: MembershipPaymentStatus, now = new Date()): Prisma.MembershipWhereInput {
  const graceStart = new Date(now.getTime() - GRACE_DAYS * DAY_MS);
  const current = { expiresAt: { gte: now } };
  switch (status) {
    case 'EXPIRED':
      return { expiresAt: { lt: now } };
    case 'PAID':
      return { ...current, fullyPaid: true };
    case 'OVERDUE':
      return { ...current, fullyPaid: false, startsAt: { lt: graceStart } };
    case 'PARTIALLY_PAID':
      return { ...current, fullyPaid: false, startsAt: { gte: graceStart }, amountPaid: { gt: 0 } };
    case 'PENDING':
      return { ...current, fullyPaid: false, startsAt: { gte: graceStart }, amountPaid: { equals: 0 } };
  }
}

/** `months` calendar months later (UTC), clamped to the month's last day. */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

/** A renewal starts when the current period ends, or today if it already has. */
export const renewalStart = (currentExpiresAt: Date | null, now = new Date()): Date =>
  currentExpiresAt && currentExpiresAt > now ? currentExpiresAt : startOfUtcDay(now);

export const startOfUtcDay = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/** Next free numeric membership number, zero-padded ("000124"). */
export function nextMembershipNumber(existing: readonly string[]): string {
  const max = existing.reduce((m, n) => (/^\d+$/.test(n) ? Math.max(m, Number(n)) : m), 0);
  return String(max + 1).padStart(6, '0');
}

/** Amount still due on a period (never negative). */
export const remainingDue = (priceDue: Prisma.Decimal | number | string, amountPaid: Prisma.Decimal | number | string) =>
  Math.max(0, Math.round((Number(priceDue) - Number(amountPaid)) * 100) / 100);
