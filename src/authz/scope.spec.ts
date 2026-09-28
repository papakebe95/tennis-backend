import { RoleScope } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ROLES } from './default-roles.js';
import { PERMISSIONS, type PermissionKey } from './permissions.js';
import { GLOBAL_SCOPE, holds, holdsAnywhere, scopeFilter, type Grant, type Scope } from './scope.js';

const org = (id: string): Scope => ({ type: RoleScope.ORGANIZATION, id });
const comp = (id: string): Scope => ({ type: RoleScope.COMPETITION, id });
const grant = (scope: Scope, ...permissions: PermissionKey[]): Grant => ({
  roleKey: 'TEST',
  scope,
  permissions: new Set(permissions),
});

describe('holds', () => {
  const clubAdminOfA = [grant(org('club-a'), 'court.manage')];

  it('grants on the organization that owns the resource', () => {
    expect(holds(clubAdminOfA, 'court.manage', [org('club-a'), GLOBAL_SCOPE])).toBe(true);
  });

  it("refuses another club's resource (no IDOR through ids)", () => {
    expect(holds(clubAdminOfA, 'court.manage', [org('club-b'), GLOBAL_SCOPE])).toBe(false);
  });

  it('refuses a permission the role does not carry', () => {
    expect(holds(clubAdminOfA, 'member.manage', [org('club-a'), GLOBAL_SCOPE])).toBe(false);
  });

  it('refuses a scoped grant on a global-only check', () => {
    expect(holds(clubAdminOfA, 'court.manage')).toBe(false);
  });

  it('lets a global grant cover any resource', () => {
    const superAdmin = [grant(GLOBAL_SCOPE, 'court.manage')];
    expect(holds(superAdmin, 'court.manage', [org('club-b'), GLOBAL_SCOPE])).toBe(true);
    expect(holds(superAdmin, 'court.manage')).toBe(true);
  });

  it('keeps an official inside their own competition', () => {
    const official = [grant(comp('teranga'), 'match.result.enter')];
    const terangaMatch = [comp('teranga'), org('club-a'), GLOBAL_SCOPE];
    const otherMatch = [comp('dakar-open'), org('club-a'), GLOBAL_SCOPE];
    expect(holds(official, 'match.result.enter', terangaMatch)).toBe(true);
    expect(holds(official, 'match.result.enter', otherMatch)).toBe(false);
  });

  it("lets the host club's admin run the club's competitions", () => {
    const clubAdmin = [grant(org('club-a'), 'draw.manage')];
    expect(holds(clubAdmin, 'draw.manage', [comp('teranga'), org('club-a'), GLOBAL_SCOPE])).toBe(true);
  });

  it('does not treat a competition grant as an organization grant with the same id', () => {
    expect(holds([grant(comp('x'), 'club.update')], 'club.update', [org('x'), GLOBAL_SCOPE])).toBe(false);
  });
});

describe('holdsAnywhere / scopeFilter', () => {
  const grants = [
    grant(org('club-a'), 'member.view'),
    grant(org('club-b'), 'member.view'),
    grant(org('club-a'), 'member.view'),
    grant(comp('teranga'), 'match.view'),
  ];

  it('reports whether the permission is held at all', () => {
    expect(holdsAnywhere(grants, 'member.view')).toBe(true);
    expect(holdsAnywhere(grants, 'member.manage')).toBe(false);
  });

  it('lists the deduplicated scopes a list query may return', () => {
    expect(scopeFilter(grants, 'member.view')).toEqual({
      global: false,
      organizationIds: ['club-a', 'club-b'],
      competitionIds: [],
    });
    expect(scopeFilter([grant(GLOBAL_SCOPE, 'member.view')], 'member.view').global).toBe(true);
  });
});

describe('default roles', () => {
  it.each(DEFAULT_ROLES.map((role) => [role.key, role] as const))(
    '%s only carries permissions grantable at its scope',
    (_key, role) => {
      for (const permission of role.permissions) {
        expect(PERMISSIONS[permission].scopes, permission).toContain(role.scope);
      }
    },
  );

  it('gives SUPER_ADMIN every grant, but not the restricting marker', () => {
    const superAdmin = DEFAULT_ROLES.find((r) => r.key === 'SUPER_ADMIN')!;
    expect(superAdmin.isSystem).toBe(true);
    expect(superAdmin.permissions).not.toContain('match.assigned_only');
    expect(superAdmin.permissions).toHaveLength(Object.keys(PERMISSIONS).length - 1);
  });

  it('does not give a tournament organizer any club power', () => {
    const organizer = DEFAULT_ROLES.find((r) => r.key === 'TOURNAMENT_ORGANIZER')!;
    expect(organizer.permissions).toEqual(['tournament.create']);
  });
});
