import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { RoleScope } from '@prisma/client';
import { isStrongPassword } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { AuthzService } from '../../authz/authz.service.js';
import type { Grant } from '../../authz/scope.js';
import { AdminUsersService, generateTemporaryPassword } from './admin-users.service.js';
import { RoleGrantsService } from './role-grants.service.js';

const orgGrant = (orgId: string, ...permissions: string[]): Grant => ({
  roleKey: 'CLUB_ADMIN',
  scope: { type: RoleScope.ORGANIZATION, id: orgId },
  permissions: new Set(permissions),
});
const globalGrant = (...permissions: string[]): Grant => ({
  roleKey: 'SUPER_ADMIN',
  scope: { type: RoleScope.GLOBAL },
  permissions: new Set(permissions),
});

function setup(role: Record<string, unknown>, organization: Record<string, unknown> | null = { id: 'org-a', type: 'CLUB', name: 'ASAC' }) {
  const prisma = {
    role: { findUnique: vi.fn().mockResolvedValue(role) },
    organization: { findUnique: vi.fn().mockResolvedValue(organization) },
    competition: { findUnique: vi.fn().mockResolvedValue({ id: 'c1', name: 'Teranga', club: null }) },
  };
  const authz = new AuthzService(prisma as never);
  const service = new RoleGrantsService(prisma as never, authz, {} as never, {} as never);
  return service;
}

const clubRole = (permissions: string[]) => ({
  id: 'r1',
  key: 'CLUB_STAFF',
  name: 'Club Staff',
  scope: RoleScope.ORGANIZATION,
  organizationType: 'CLUB',
  permissions: permissions.map((permissionKey) => ({ permissionKey })),
});

describe('RoleGrantsService.resolve', () => {
  it('refuses an organization on a platform-wide role', async () => {
    const service = setup({ ...clubRole([]), scope: RoleScope.GLOBAL });
    await expect(service.resolve({ roleId: 'r1', organizationId: 'org-a' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires the organization of an organization role', async () => {
    const service = setup(clubRole([]));
    await expect(service.resolve({ roleId: 'r1' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a club role on a federation', async () => {
    const service = setup(clubRole([]), { id: 'fed', type: 'FEDERATION', name: 'FST' });
    await expect(service.resolve({ roleId: 'r1', organizationId: 'fed' })).rejects.toThrow('This role applies to a CLUB');
  });

  it('scopes the grant to the organization', async () => {
    const service = setup(clubRole([]));
    const resolved = await service.resolve({ roleId: 'r1', organizationId: 'org-a', competitionId: undefined });
    expect(resolved.scope).toEqual({ organizationId: 'org-a', competitionId: null });
  });
});

describe('RoleGrantsService.assertMayGrant', () => {
  const run = async (actor: Grant[], rolePermissions: string[], orgId = 'org-a') => {
    const service = setup(clubRole(rolePermissions), { id: orgId, type: 'CLUB', name: 'X' });
    const resolved = await service.resolve({ roleId: 'r1', organizationId: orgId });
    return () => service.assertMayGrant(actor, resolved);
  };

  it('lets a club admin hand out a smaller role in their club', async () => {
    const check = await run([orgGrant('org-a', 'user.roles.assign', 'booking.view', 'member.view')], ['booking.view']);
    expect(check).not.toThrow();
  });

  it('refuses a role carrying a permission the granter lacks (escalation)', async () => {
    const check = await run([orgGrant('org-a', 'user.roles.assign', 'booking.view')], ['booking.view', 'payment.refund']);
    expect(check).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION' }) }));
  });

  it("refuses granting in another club even with the same powers", async () => {
    const check = await run([orgGrant('org-a', 'user.roles.assign', 'booking.view')], ['booking.view'], 'org-b');
    expect(check).toThrow(ForbiddenException);
  });

  it('lets a global administrator grant anywhere', async () => {
    const check = await run([globalGrant('user.roles.assign', 'booking.view')], ['booking.view'], 'org-z');
    expect(check).not.toThrow();
  });
});

describe('RoleGrantsService.assertAnotherSuperAdmin', () => {
  it('refuses to remove the last active Super Admin', async () => {
    const service = setup(clubRole([]));
    const tx = { userRole: { count: vi.fn().mockResolvedValue(0) } };
    await expect(service.assertAnotherSuperAdmin(tx as never, 'u1')).rejects.toBeInstanceOf(ConflictException);
    tx.userRole.count.mockResolvedValue(1);
    await expect(service.assertAnotherSuperAdmin(tx as never, 'u1')).resolves.toBeUndefined();
  });
});

describe('AdminUsersService', () => {
  it('generates temporary passwords that meet the policy', () => {
    for (let i = 0; i < 50; i++) {
      const password = generateTemporaryPassword();
      expect(password).toHaveLength(12);
      expect(isStrongPassword(password, { minLength: 10, minLowercase: 1, minUppercase: 1, minNumbers: 1, minSymbols: 1 })).toBe(true);
    }
  });

  it("refuses to act on an account with more rights than the actor's", async () => {
    const prisma = { user: { findUnique: vi.fn().mockResolvedValue({ id: 'target', status: 'ACTIVE' }) } };
    const authz = { loadGrants: vi.fn().mockResolvedValue([globalGrant('role.manage', 'user.view')]) };
    const service = new AdminUsersService(prisma as never, authz as never, {} as never, {} as never);
    const actor = { id: 'me', grants: [globalGrant('user.status.manage', 'user.view')] };
    await expect(service.setStatus(actor, 'target', { status: 'SUSPENDED' })).rejects.toMatchObject({
      response: { code: 'PRIVILEGE_ESCALATION' },
    });
  });

  it('refuses to change or reset your own account from the admin screens', async () => {
    const service = new AdminUsersService({} as never, {} as never, {} as never, {} as never);
    const actor = { id: 'me', grants: [] };
    await expect(service.setStatus(actor, 'me', { status: 'DISABLED' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.resetPassword(actor, 'me')).rejects.toBeInstanceOf(BadRequestException);
  });
});
