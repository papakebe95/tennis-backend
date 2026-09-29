import type { Prisma } from '@prisma/client';

/** "+221 77 123 45 67" → "••••••••4567": enough to tell people apart at a desk. */
export const maskPhone = (msisdn: string) => `${'•'.repeat(Math.max(0, msisdn.length - 4))}${msisdn.slice(-4)}`;

/**
 * People matching a search box: an exact phone match (8+ digits, compared on
 * the national part) or every word found in the first or last name.
 */
export function personSearchWhere(q: string): Prisma.UserWhereInput {
  const digits = q.replace(/\D/g, '');
  return {
    OR: [
      ...(digits.length >= 8 ? [{ msisdn: { endsWith: digits.slice(-9) } }] : []),
      {
        AND: q
          .split(/\s+/)
          .filter(Boolean)
          .map((part) => ({
            OR: [
              { firstname: { contains: part, mode: 'insensitive' as const } },
              { lastname: { contains: part, mode: 'insensitive' as const } },
            ],
          })),
      },
    ],
  };
}
