import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { AuditService, redact } from './audit.service.js';

describe('redact', () => {
  it('strips secrets at any depth and serializes dates and decimals', () => {
    const at = new Date('2026-09-28T10:00:00Z');
    expect(
      redact({
        passwordHash: 'x',
        profile: { refreshToken: 'y', name: 'Awa' },
        list: [{ tokenHash: 'z' }],
        price: new Prisma.Decimal('12.50'),
        at,
      }),
    ).toEqual({
      passwordHash: '[redacted]',
      profile: { refreshToken: '[redacted]', name: 'Awa' },
      list: [{ tokenHash: '[redacted]' }],
      price: '12.5',
      at: '2026-09-28T10:00:00.000Z',
    });
  });
});

describe('AuditService.record', () => {
  it('writes through the transaction client it is given', async () => {
    const prisma = { auditLog: { create: vi.fn() } };
    const tx = { auditLog: { create: vi.fn() } };
    await new AuditService(prisma as never).record(
      { actorId: 'u1', action: 'court.updated', entityType: 'Court', entityId: 'c1', before: { pricePerHour: 10 } },
      tx as never,
    );
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({
      actorId: 'u1',
      action: 'court.updated',
      before: { pricePerHour: 10 },
      organizationId: null,
    });
  });
});
