import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service.js';

// A P2002 the way Prisma actually throws it — the real class so
// `instanceof` in AuthService.register matches, like it would in prod.
const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.10.0',
  });

const dto = (overrides: Record<string, unknown> = {}) => ({
  email: 'new@example.com',
  password: 'password123',
  firstname: 'New',
  lastname: 'Player',
  msisdn: '+221 77 000 01 01',
  ...overrides,
});

const build = (overrides: Record<string, unknown> = {}) => {
  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'u1', email: 'new@example.com' }),
    },
    userPhone: { findUnique: vi.fn().mockResolvedValue(null) },
    refreshToken: {
      create: vi.fn().mockResolvedValue({ id: 'rt1' }),
    },
    ...overrides,
  };
  const jwtService = { signAsync: vi.fn().mockResolvedValue('access-token') };
  const configService = { get: vi.fn().mockReturnValue('secret') };
  return {
    service: new AuthService(prisma as never, jwtService as never, configService as never),
    prisma,
  };
};

describe('AuthService.register', () => {
  it('rejects a phone number that is not one', async () => {
    const { service, prisma } = build();
    await expect(
      service.register(dto({ msisdn: 'not-a-phone' })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('normalizes the phone before checking and storing it', async () => {
    const { service, prisma } = build();
    await service.register(dto({ msisdn: '+221 77 000-01-01' }));

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { msisdn: '+221770000101' },
    });
    expect(prisma.user.create.mock.calls[0][0].data.msisdn).toBe(
      '+221770000101',
    );
  });

  it('rejects a duplicate email with a clear message, not a crash', async () => {
    const { service, prisma } = build({
      user: {
        findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
          'email' in where ? { id: 'existing' } : null,
        ),
        create: vi.fn(),
      },
    });
    await expect(service.register(dto())).rejects.toThrow(
      'Email is already registered',
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('rejects a phone already registered as someone else\'s primary number', async () => {
    const { service, prisma } = build({
      user: {
        findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
          'msisdn' in where ? { id: 'existing' } : null,
        ),
        create: vi.fn(),
      },
    });
    await expect(service.register(dto())).rejects.toThrow(
      'This phone number is already registered',
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("rejects a phone already saved as someone else's extra number", async () => {
    const { service, prisma } = build({
      userPhone: { findUnique: vi.fn().mockResolvedValue({ id: 'extra' }) },
    });
    await expect(service.register(dto())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('turns a raced unique-constraint hit into a clear 409, not a 500', async () => {
    const { service } = build({
      user: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockRejectedValue(uniqueViolation()),
      },
    });
    await expect(service.register(dto())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('registers and issues a token pair when the number is free', async () => {
    const { service } = build();
    const tokens = await service.register(dto());
    expect(tokens.accessToken).toBe('access-token');
    expect(tokens.refreshToken).toMatch(/^rt1\./);
  });
});
