import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { RoleScope } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { AuthzService } from './authz.service.js';
import { PermissionGuard, type PermissionRequirement } from './permission.guard.js';
import type { Grant } from './scope.js';

const clubAdminOf = (orgId: string): Grant => ({
  roleKey: 'CLUB_ADMIN',
  scope: { type: RoleScope.ORGANIZATION, id: orgId },
  permissions: new Set(['court.manage', 'court.view']),
});

function setup(requirement: PermissionRequirement, grants: Grant[], courtOrg: string | null) {
  const prisma = {
    court: {
      findUnique: vi.fn().mockResolvedValue(
        courtOrg ? { club: { organizationId: courtOrg } } : null,
      ),
    },
  };
  const authz = new AuthzService(prisma as never);
  vi.spyOn(authz, 'loadGrants').mockResolvedValue(grants);
  const reflector = { getAllAndOverride: vi.fn().mockReturnValue(requirement) };
  const guard = new PermissionGuard(reflector as never, authz);
  const request = { user: { userId: 'u1' }, params: { courtId: 'court-1' } };
  const context = {
    getHandler: () => null,
    getClass: () => null,
    switchToHttp: () => ({ getRequest: () => request }),
  };
  return { run: () => guard.canActivate(context as never), prisma, request };
}

describe('PermissionGuard', () => {
  const onCourt: PermissionRequirement = { permission: 'court.manage', resource: 'court', param: 'courtId' };

  it("allows a club admin on their own club's court", async () => {
    const { run } = setup(onCourt, [clubAdminOf('org-a')], 'org-a');
    await expect(run()).resolves.toBe(true);
  });

  it("forbids a club admin on another club's court", async () => {
    const { run } = setup(onCourt, [clubAdminOf('org-a')], 'org-b');
    await expect(run()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('answers 403 without looking the resource up when the permission is held nowhere', async () => {
    const { run, prisma } = setup(onCourt, [], 'org-a');
    await expect(run()).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.court.findUnique).not.toHaveBeenCalled();
  });

  it('answers 404 for a missing resource to someone who could otherwise act', async () => {
    const { run } = setup(onCourt, [clubAdminOf('org-a')], null);
    await expect(run()).rejects.toBeInstanceOf(NotFoundException);
  });

  it('requires a global grant when no resource is named', async () => {
    const { run } = setup({ permission: 'court.view' }, [clubAdminOf('org-a')], null);
    await expect(run()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('accepts a grant anywhere for list endpoints and exposes the grants', async () => {
    const grants = [clubAdminOf('org-a')];
    const { run, request } = setup({ permission: 'court.view', anywhere: true }, grants, null);
    await expect(run()).resolves.toBe(true);
    expect((request as { grants?: Grant[] }).grants).toBe(grants);
  });
});
