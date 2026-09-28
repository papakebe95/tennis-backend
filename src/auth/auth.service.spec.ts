import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
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
      create: vi.fn().mockResolvedValue({ id: 'u1', email: 'new@example.com', tokenVersion: 0 }),
    },
    userPhone: { findUnique: vi.fn().mockResolvedValue(null) },
    refreshToken: {
      create: vi.fn().mockResolvedValue({ id: 'rt1' }),
    },
    ...overrides,
  };
  const jwtService = { signAsync: vi.fn().mockResolvedValue('access-token') };
  const configService = {
    get: vi.fn((key: string, fallback?: string) =>
      key === 'DEFAULT_CALLING_CODE' ? fallback : 'secret',
    ),
  };
  return {
    service: new AuthService(prisma as never, jwtService as never, configService as never, {} as never),
    prisma,
    jwtService,
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

  it('stores a local number in international form', async () => {
    const { service, prisma } = build();
    await service.register(dto({ msisdn: '77 000 01 01' }));
    expect(prisma.user.create.mock.calls[0][0].data.msisdn).toBe('+221770000101');
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

describe('AuthService.login', () => {
  const account = async (overrides: Record<string, unknown> = {}) => ({
    id: 'u1',
    email: 'awa@example.com',
    msisdn: '+221770000001',
    status: 'ACTIVE',
    tokenVersion: 0,
    passwordHash: await bcrypt.hash('Admin@2026!', 4),
    ...overrides,
  });
  const buildLogin = (user: unknown) =>
    build({
      user: {
        findFirst: vi.fn().mockResolvedValue(user),
        findUnique: vi.fn().mockResolvedValue(user),
        update: vi.fn(),
      },
    });

  it('finds a local phone number stored in international form', async () => {
    const { service, prisma } = buildLogin(await account());
    await service.login({ identifier: '77 000 00 01', password: 'Admin@2026!' });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { msisdn: '+221770000001' },
    });
  });

  it('still accepts the legacy email field', async () => {
    const { service } = buildLogin(await account());
    await expect(
      service.login({ email: 'AWA@example.com', password: 'Admin@2026!' }),
    ).resolves.toHaveProperty('accessToken');
  });

  it('answers the same 401 for an unknown account and a wrong password', async () => {
    const unknown = buildLogin(null);
    const wrong = buildLogin(await account());
    const u = await unknown.service.login({ identifier: '+221770000009', password: 'x' }).catch((e: unknown) => e);
    const w = await wrong.service.login({ identifier: '+221770000001', password: 'x' }).catch((e: unknown) => e);
    expect(u).toBeInstanceOf(UnauthorizedException);
    expect((u as UnauthorizedException).getResponse()).toEqual((w as UnauthorizedException).getResponse());
  });

  it.each([
    ['SUSPENDED', 'ACCOUNT_SUSPENDED'],
    ['DISABLED', 'ACCOUNT_DISABLED'],
    ['REJECTED', 'ACCOUNT_REJECTED'],
  ])('refuses a %s account with code %s once the password is right', async (status, code) => {
    const { service } = buildLogin(await account({ status }));
    const error = await service
      .login({ identifier: '+221770000001', password: 'Admin@2026!' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({ code });
  });

  it('lets a PENDING account sign in (restricted area)', async () => {
    const { service } = buildLogin(await account({ status: 'PENDING' }));
    await expect(
      service.login({ identifier: '+221770000001', password: 'Admin@2026!' }),
    ).resolves.toHaveProperty('accessToken');
  });

  it('puts the token version in the access token', async () => {
    const { service, jwtService } = buildLogin(await account({ tokenVersion: 3 }));
    await service.login({ identifier: '+221770000001', password: 'Admin@2026!' });
    expect(jwtService.signAsync.mock.calls[0][0]).toMatchObject({ sub: 'u1', ver: 3 });
  });
});
