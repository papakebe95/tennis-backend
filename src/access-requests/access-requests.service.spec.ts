import { BadRequestException, ConflictException } from '@nestjs/common';
import { RoleScope } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { weeklySeries } from '../admin/dashboard/dashboard.service.js';
import { validatePermissions } from '../admin/roles/roles.service.js';
import { AccessRequestsService } from './access-requests.service.js';

const ROLES: Record<string, object> = {
  CLUB_ADMIN: { id: 'r-club', key: 'CLUB_ADMIN', name: 'Club Admin', scope: RoleScope.ORGANIZATION, organizationType: 'CLUB', selfRegistrable: true },
  TOURNAMENT_ORGANIZER: { id: 'r-org', key: 'TOURNAMENT_ORGANIZER', name: 'Organizer', scope: RoleScope.GLOBAL, organizationType: null, selfRegistrable: true },
  CLUB_STAFF: { id: 'r-staff', key: 'CLUB_STAFF', name: 'Staff', scope: RoleScope.ORGANIZATION, organizationType: 'CLUB', selfRegistrable: false },
};

function setup(overrides: { open?: number; held?: number; organization?: object | null } = {}) {
  const prisma = {
    role: { findUnique: vi.fn(({ where }: { where: { key: string } }) => ROLES[where.key] ?? null) },
    organization: {
      findUnique: vi.fn().mockResolvedValue(
        overrides.organization === undefined ? { id: 'org-a', type: 'CLUB', status: 'ACTIVE' } : overrides.organization,
      ),
    },
    city: { findUnique: vi.fn().mockResolvedValue({ id: 'dakar', countryId: 'sn' }) },
    accessRequest: { count: vi.fn().mockResolvedValue(overrides.open ?? 0) },
    userRole: { count: vi.fn().mockResolvedValue(overrides.held ?? 0) },
  };
  return new AccessRequestsService(prisma as never, {} as never, {} as never, {} as never);
}

describe('AccessRequestsService.validate', () => {
  it('only offers self-registrable profiles', async () => {
    await expect(setup().validate(null, { roleKey: 'CLUB_STAFF', organizationId: 'org-a' })).rejects.toThrow(
      'This profile is not available for registration',
    );
  });

  it('accepts an existing club for a club admin', async () => {
    const request = await setup().validate(null, { roleKey: 'CLUB_ADMIN', organizationId: 'org-a' });
    expect(request).toMatchObject({ organizationId: 'org-a', proposedOrganization: null });
  });

  it('refuses a federation for a club profile', async () => {
    const service = setup({ organization: { id: 'fed', type: 'FEDERATION', status: 'ACTIVE' } });
    await expect(service.validate(null, { roleKey: 'CLUB_ADMIN', organizationId: 'fed' })).rejects.toThrow(
      'This profile applies to a CLUB',
    );
  });

  it('refuses an inactive organization', async () => {
    const service = setup({ organization: { id: 'org-a', type: 'CLUB', status: 'SUSPENDED' } });
    await expect(service.validate(null, { roleKey: 'CLUB_ADMIN', organizationId: 'org-a' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('needs a city for a proposed club, and fills in its country', async () => {
    const service = setup();
    await expect(
      service.validate(null, { roleKey: 'CLUB_ADMIN', proposedOrganization: { type: 'CLUB', name: 'TC Saly' } }),
    ).rejects.toThrow('Choose the city of the new club');
    const request = await service.validate(null, {
      roleKey: 'CLUB_ADMIN',
      proposedOrganization: { type: 'CLUB', name: 'TC Saly', cityId: 'dakar' },
    });
    expect(request.proposedOrganization?.countryId).toBe('sn');
  });

  it('wants an organization, but not two, for organization profiles', async () => {
    await expect(setup().validate(null, { roleKey: 'CLUB_ADMIN' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      setup().validate(null, {
        roleKey: 'CLUB_ADMIN',
        organizationId: 'org-a',
        proposedOrganization: { type: 'CLUB', name: 'TC Saly', cityId: 'dakar' },
      }),
    ).rejects.toThrow('not both');
  });

  it('refuses an organization on a platform-wide profile', async () => {
    await expect(setup().validate(null, { roleKey: 'TOURNAMENT_ORGANIZER', organizationId: 'org-a' })).rejects.toThrow(
      'not tied to an organization',
    );
  });

  it('refuses a duplicate open request or a role already held', async () => {
    await expect(setup({ open: 1 }).validate('u1', { roleKey: 'TOURNAMENT_ORGANIZER' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(setup({ held: 1 }).validate('u1', { roleKey: 'TOURNAMENT_ORGANIZER' })).rejects.toThrow(
      'You already hold this role',
    );
  });
});

describe('validatePermissions', () => {
  it('rejects unknown keys and keys that make no sense at the scope', () => {
    expect(() => validatePermissions(['court.fly'], RoleScope.GLOBAL)).toThrow('Unknown permission court.fly');
    expect(() => validatePermissions(['user.view'], RoleScope.ORGANIZATION)).toThrow(
      'user.view cannot be granted at the ORGANIZATION level',
    );
    expect(validatePermissions(['court.view', 'booking.view', 'court.view'], RoleScope.ORGANIZATION)).toEqual([
      'booking.view',
      'court.view',
    ]);
  });
});

describe('weeklySeries', () => {
  it('fills missing weeks with zero, oldest first, ending this week', () => {
    const now = new Date('2026-09-30T12:00:00Z'); // Wednesday
    const series = weeklySeries([{ week: new Date('2026-09-21T00:00:00Z'), count: 4 }], now, 3);
    expect(series).toEqual([
      { week: '2026-09-14', count: 0 },
      { week: '2026-09-21', count: 4 },
      { week: '2026-09-28', count: 0 },
    ]);
  });
});
