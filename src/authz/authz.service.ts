import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { OrganizationStatus, RoleScope } from '@prisma/client';
import { t } from '../i18n/i18n.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { syncAuthorizationCatalog } from './catalog-sync.js';
import type { PermissionKey } from './permissions.js';
import { GLOBAL_SCOPE, holds, type Grant, type Scope } from './scope.js';

/** Resource kinds a permission check can be anchored on. */
export type ResourceType =
  | 'organization'
  | 'club'
  | 'court'
  | 'competition'
  | 'member'
  | 'membershipPlan'
  | 'payment'
  | 'booking'
  | 'event'
  | 'registration'
  | 'match'
  | 'membershipRequest';

const org = (id: string): Scope => ({ type: RoleScope.ORGANIZATION, id });

@Injectable()
export class AuthzService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuthzService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap() {
    await syncAuthorizationCatalog(this.prisma);
    this.logger.log('Authorization catalog synced');
  }

  /** The user's active grants with their permissions flattened. */
  async loadGrants(userId: string): Promise<Grant[]> {
    const rows = await this.prisma.userRole.findMany({
      where: activeGrantWhere(userId),
      select: {
        organizationId: true,
        competitionId: true,
        role: {
          select: {
            key: true,
            scope: true,
            permissions: { select: { permissionKey: true } },
          },
        },
      },
    });
    return rows.flatMap((row): Grant[] => {
      const scope = grantScope(row.role.scope, row);
      if (!scope) return []; // inconsistent row: grants nothing
      return [
        {
          roleKey: row.role.key,
          scope,
          permissions: new Set(row.role.permissions.map((p) => p.permissionKey)),
        },
      ];
    });
  }

  /**
   * Scopes that cover the resource, read from the stored row — never from the
   * request — so changing an id in a payload can't widen access.
   */
  async scopeChain(resource: ResourceType, id: string): Promise<Scope[]> {
    const notFound = () => new NotFoundException(t('errors.http.notFound'));
    switch (resource) {
      case 'organization': {
        const row = await this.prisma.organization.findUnique({ where: { id }, select: { id: true } });
        if (!row) throw notFound();
        return [org(row.id), GLOBAL_SCOPE];
      }
      case 'club': {
        const row = await this.prisma.club.findUnique({ where: { id }, select: { organizationId: true } });
        if (!row) throw notFound();
        return [org(row.organizationId), GLOBAL_SCOPE];
      }
      case 'court': {
        const row = await this.prisma.court.findUnique({
          where: { id },
          select: { club: { select: { organizationId: true } } },
        });
        if (!row) throw notFound();
        return [org(row.club.organizationId), GLOBAL_SCOPE];
      }
      case 'member': {
        const row = await this.prisma.clubMember.findUnique({ where: { id }, select: { club: { select: { organizationId: true } } } });
        if (!row) throw notFound();
        return [org(row.club.organizationId), GLOBAL_SCOPE];
      }
      case 'membershipPlan': {
        const row = await this.prisma.membershipPlan.findUnique({ where: { id }, select: { club: { select: { organizationId: true } } } });
        if (!row) throw notFound();
        return [org(row.club.organizationId), GLOBAL_SCOPE];
      }
      case 'payment': {
        const row = await this.prisma.payment.findUnique({ where: { id }, select: { organizationId: true } });
        if (!row) throw notFound();
        return [org(row.organizationId), GLOBAL_SCOPE];
      }
      case 'membershipRequest': {
        const row = await this.prisma.clubMembershipRequest.findUnique({ where: { id }, select: { club: { select: { organizationId: true } } } });
        if (!row) throw notFound();
        return [org(row.club.organizationId), GLOBAL_SCOPE];
      }
      case 'booking': {
        const row = await this.prisma.booking.findUnique({
          where: { id },
          select: { court: { select: { club: { select: { organizationId: true } } } } },
        });
        if (!row) throw notFound();
        return [org(row.court.club.organizationId), GLOBAL_SCOPE];
      }
      case 'competition':
        return this.competitionChain(id);
      case 'event': {
        const row = await this.prisma.competitionEvent.findUnique({ where: { id }, select: { competitionId: true } });
        if (!row) throw notFound();
        return this.competitionChain(row.competitionId);
      }
      case 'match': {
        const row = await this.prisma.competitionMatch.findUnique({ where: { id }, select: { round: { select: { competitionId: true } } } });
        if (!row) throw notFound();
        return this.competitionChain(row.round.competitionId);
      }
      case 'registration': {
        const row = await this.prisma.competitionParticipant.findUnique({ where: { id }, select: { competitionId: true } });
        if (!row) throw notFound();
        return this.competitionChain(row.competitionId);
      }
    }
  }

  /** A tournament is covered by grants on itself and on its host organization. */
  private async competitionChain(id: string): Promise<Scope[]> {
    const row = await this.prisma.competition.findUnique({ where: { id }, select: { id: true, hostOrganizationId: true } });
    if (!row) throw new NotFoundException(t('errors.http.notFound'));
    return [
      { type: RoleScope.COMPETITION, id: row.id },
      ...(row.hostOrganizationId ? [org(row.hostOrganizationId)] : []),
      GLOBAL_SCOPE,
    ];
  }

  /**
   * The signed-in user and what they may do, for the back-office to build its
   * menus and route guards (the API still checks every call itself).
   */
  async describeAccess(userId: string) {
    const [user, rows] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          firstname: true,
          lastname: true,
          msisdn: true,
          status: true,
          lastLoginAt: true,
          passwordChangedAt: true,
          mustChangePassword: true,
          playerProfile: { select: { avatarUrl: true } },
        },
      }),
      this.prisma.userRole.findMany({
        where: activeGrantWhere(userId),
        // Stable order (grants made together share a timestamp): the first
        // one decides the back-office's default workspace.
        orderBy: [{ grantedAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          grantedAt: true,
          role: {
            select: {
              key: true,
              name: true,
              scope: true,
              permissions: { select: { permissionKey: true } },
            },
          },
          organization: {
            select: { id: true, name: true, type: true, status: true, logoUrl: true, club: { select: { id: true } } },
          },
          competition: { select: { id: true, name: true } },
        },
      }),
    ]);
    if (!user) throw new NotFoundException(t('errors.users.notFound'));

    const { playerProfile, ...profile } = user;
    return {
      user: { ...profile, avatarUrl: playerProfile?.avatarUrl ?? null },
      grants: rows.map(({ role, organization, competition, ...grant }) => ({
        ...grant,
        roleKey: role.key,
        roleName: role.name,
        scope: role.scope,
        organization: organization && {
          id: organization.id,
          name: organization.name,
          type: organization.type,
          status: organization.status,
          logoUrl: organization.logoUrl,
          clubId: organization.club?.id ?? null,
        },
        competition,
        permissions: role.permissions.map((p) => p.permissionKey).sort(),
      })),
    };
  }

  /** Throws 403 unless `permission` is held somewhere on `chain`. */
  assert(grants: readonly Grant[], permission: PermissionKey, chain?: readonly Scope[]) {
    if (!holds(grants, permission, chain)) throw forbidden();
  }
}

/**
 * Grants in effect: not revoked, and not on a suspended or archived
 * organization (suspending a club freezes its administrators).
 */
const activeGrantWhere = (userId: string) => ({
  userId,
  revokedAt: null,
  OR: [{ organizationId: null }, { organization: { status: OrganizationStatus.ACTIVE } }],
});

export const forbidden = () =>
  new ForbiddenException({ message: t('errors.http.forbidden'), code: 'FORBIDDEN' });

function grantScope(
  roleScope: RoleScope,
  row: { organizationId: string | null; competitionId: string | null },
): Scope | null {
  switch (roleScope) {
    case RoleScope.GLOBAL:
      return GLOBAL_SCOPE;
    case RoleScope.ORGANIZATION:
      return row.organizationId ? org(row.organizationId) : null;
    case RoleScope.COMPETITION:
      return row.competitionId ? { type: RoleScope.COMPETITION, id: row.competitionId } : null;
  }
}
