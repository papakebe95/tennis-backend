import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RoleScope, UserStatus } from '@prisma/client';
import { AuditService } from '../../audit/audit.service.js';
import { AuthzService } from '../../authz/authz.service.js';
import { SUPER_ADMIN_ROLE_KEY } from '../../authz/default-roles.js';
import { GLOBAL_SCOPE, missingFor, holds, type Grant, type Scope } from '../../authz/scope.js';
import { t } from '../../i18n/i18n.js';
import { roleGranted } from '../../notifications/notification-messages.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface GrantTarget {
  roleId: string;
  organizationId?: string | null;
  competitionId?: string | null;
}

type Tx = Prisma.TransactionClient;

export const escalation = () =>
  new ForbiddenException({ message: t('errors.admin.escalation'), code: 'PRIVILEGE_ESCALATION' });

/**
 * Granting and revoking roles, shared by the users screens and access-request
 * approval. Rules, all enforced here:
 * - the role's scope decides which of organizationId / competitionId is set;
 * - the actor needs `user.roles.assign` where the grant would sit;
 * - the actor must already hold, there, every permission the role carries
 *   (no handing out more than you have);
 * - the platform always keeps one active Super Admin.
 */
@Injectable()
export class RoleGrantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Validates a grant and returns its role and scope chain. */
  async resolve(target: GrantTarget) {
    const role = await this.prisma.role.findUnique({
      where: { id: target.roleId },
      include: { permissions: { select: { permissionKey: true } } },
    });
    if (!role) throw new NotFoundException(t('errors.admin.roleNotFound'));

    const { organizationId, competitionId } = target;
    let chain: Scope[] = [GLOBAL_SCOPE];
    let scopeName = 'Tennis Back-Office';
    if (role.scope === RoleScope.GLOBAL) {
      if (organizationId || competitionId) throw new BadRequestException(t('errors.admin.grantNoScope'));
    } else if (role.scope === RoleScope.ORGANIZATION) {
      if (!organizationId || competitionId) {
        throw new BadRequestException(t('errors.admin.grantNeedsOrganization'));
      }
      const organization = await this.prisma.organization.findUnique({ where: { id: organizationId } });
      if (!organization) throw new NotFoundException(t('errors.admin.organizationNotFound'));
      if (role.organizationType && role.organizationType !== organization.type) {
        throw new BadRequestException(t('errors.admin.grantOrganizationType', { type: role.organizationType }));
      }
      chain = await this.authz.scopeChain('organization', organizationId);
      scopeName = organization.name;
    } else {
      if (!competitionId || organizationId) {
        throw new BadRequestException(t('errors.admin.grantNeedsCompetition'));
      }
      const competition = await this.prisma.competition.findUnique({ where: { id: competitionId } });
      if (!competition) throw new NotFoundException(t('errors.admin.competitionNotFound'));
      chain = await this.authz.scopeChain('competition', competitionId);
      scopeName = competition.name;
    }
    return {
      role,
      chain,
      scopeName,
      scope: {
        organizationId: role.scope === RoleScope.ORGANIZATION ? organizationId! : null,
        competitionId: role.scope === RoleScope.COMPETITION ? competitionId! : null,
      },
    };
  }

  /** The actor may hand out this role at this scope. */
  assertMayGrant(actorGrants: readonly Grant[], resolved: Awaited<ReturnType<RoleGrantsService['resolve']>>) {
    if (!holds(actorGrants, 'user.roles.assign', resolved.chain)) {
      throw new ForbiddenException({ message: t('errors.http.forbidden'), code: 'FORBIDDEN' });
    }
    const rolePermissions = resolved.role.permissions.map((p) => p.permissionKey);
    if (missingFor(actorGrants, rolePermissions, resolved.chain).length) throw escalation();
  }

  /**
   * Creates the grant inside `tx` (plus its audit row). Returns null when the
   * user already holds the same role at the same scope.
   */
  async createInTx(
    tx: Tx,
    actorId: string | null,
    userId: string,
    resolved: Awaited<ReturnType<RoleGrantsService['resolve']>>,
    reason?: string,
  ) {
    const existing = await tx.userRole.findFirst({
      where: { userId, roleId: resolved.role.id, revokedAt: null, ...resolved.scope },
    });
    if (existing) return null;
    const grant = await tx.userRole.create({
      data: { userId, roleId: resolved.role.id, grantedById: actorId, ...resolved.scope },
    });
    await this.audit.record(
      {
        actorId,
        action: 'user.roles.granted',
        entityType: 'User',
        entityId: userId,
        ...resolved.scope,
        after: { grantId: grant.id, role: resolved.role.key, ...resolved.scope },
        reason,
      },
      tx,
    );
    return grant;
  }

  /** Grant from the users screen: all checks, then notify the user. */
  async grant(actorGrants: readonly Grant[], actorId: string, userId: string, target: GrantTarget) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, status: true } });
    if (!user) throw new NotFoundException(t('errors.users.notFound'));
    if (user.status === UserStatus.PENDING) {
      throw new ConflictException(t('errors.admin.grantPendingUser'));
    }
    const resolved = await this.resolve(target);
    this.assertMayGrant(actorGrants, resolved);

    const grant = await this.prisma.$transaction((tx) => this.createInTx(tx, actorId, userId, resolved));
    if (!grant) throw new ConflictException(t('errors.admin.grantDuplicate'));
    await this.notifications.notify(userId, roleGranted(resolved.role.name, resolved.scopeName));
    return grant;
  }

  async revoke(actorGrants: readonly Grant[], actorId: string, userId: string, grantId: string, reason?: string) {
    const grant = await this.prisma.userRole.findFirst({
      where: { id: grantId, userId, revokedAt: null },
      include: { role: { select: { key: true } } },
    });
    if (!grant) throw new NotFoundException(t('errors.admin.grantNotFound'));

    const chain = grant.organizationId
      ? await this.authz.scopeChain('organization', grant.organizationId)
      : grant.competitionId
        ? await this.authz.scopeChain('competition', grant.competitionId)
        : [GLOBAL_SCOPE];
    if (!holds(actorGrants, 'user.roles.assign', chain)) {
      throw new ForbiddenException({ message: t('errors.http.forbidden'), code: 'FORBIDDEN' });
    }

    await this.prisma.$transaction(async (tx) => {
      if (grant.role.key === SUPER_ADMIN_ROLE_KEY) await this.assertAnotherSuperAdmin(tx, userId);
      await tx.userRole.update({ where: { id: grant.id }, data: { revokedAt: new Date() } });
      await this.audit.record(
        {
          actorId,
          action: 'user.roles.revoked',
          entityType: 'User',
          entityId: userId,
          organizationId: grant.organizationId,
          competitionId: grant.competitionId,
          before: { grantId: grant.id, role: grant.role.key },
          reason,
        },
        tx,
      );
      // Serializable: two admins revoking the last two Super Admins at once
      // can't both pass the check.
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  /** Throws unless an active Super Admin other than `userId` remains. */
  async assertAnotherSuperAdmin(tx: Tx, userId: string) {
    const others = await tx.userRole.count({
      where: {
        revokedAt: null,
        role: { key: SUPER_ADMIN_ROLE_KEY },
        userId: { not: userId },
        user: { status: UserStatus.ACTIVE },
      },
    });
    if (others === 0) {
      throw new ConflictException({ message: t('errors.admin.lastSuperAdmin'), code: 'LAST_SUPER_ADMIN' });
    }
  }
}
