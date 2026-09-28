import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'node:crypto';
import { AuditService } from '../../audit/audit.service.js';
import { AuthzService } from '../../authz/authz.service.js';
import { SUPER_ADMIN_ROLE_KEY } from '../../authz/default-roles.js';
import { missingFor, type Grant } from '../../authz/scope.js';
import { orderBy, pageArgs, searchText, toPage } from '../../common/pagination.js';
import { t } from '../../i18n/i18n.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { ListUsersQueryDto, SetUserStatusDto } from './admin-users.dto.js';
import { escalation, RoleGrantsService } from './role-grants.service.js';

const grantSelect = {
  id: true,
  grantedAt: true,
  revokedAt: true,
  role: { select: { id: true, key: true, name: true, scope: true } },
  organization: { select: { id: true, name: true, type: true } },
  competition: { select: { id: true, name: true } },
} satisfies Prisma.UserRoleSelect;

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly grants: RoleGrantsService,
  ) {}

  async list(query: ListUsersQueryDto) {
    const q = searchText(query.q);
    const digits = q?.replace(/\D/g, '');
    const where: Prisma.UserWhereInput = {
      status: query.status,
      ...(query.roleKey || query.organizationId
        ? {
            roles: {
              some: {
                revokedAt: null,
                ...(query.roleKey ? { role: { key: query.roleKey } } : {}),
                ...(query.organizationId ? { organizationId: query.organizationId } : {}),
              },
            },
          }
        : {}),
      ...(q
        ? {
            OR: [
              { firstname: { contains: q, mode: 'insensitive' } },
              { lastname: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
              ...(digits && digits.length >= 3 ? [{ msisdn: { contains: digits } }] : []),
            ],
          }
        : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        ...pageArgs(query),
        orderBy: orderBy(query.sort, ['createdAt', 'lastLoginAt', 'lastname', 'status'], {
          field: 'createdAt',
          direction: 'desc',
        }),
        select: {
          id: true,
          firstname: true,
          lastname: true,
          email: true,
          msisdn: true,
          status: true,
          createdAt: true,
          lastLoginAt: true,
          playerProfile: { select: { avatarUrl: true } },
          roles: { where: { revokedAt: null }, select: grantSelect, orderBy: { grantedAt: 'asc' } },
        },
      }),
    ]);
    return toPage(
      rows.map(({ playerProfile, roles, ...user }) => ({
        ...user,
        avatarUrl: playerProfile?.avatarUrl ?? null,
        grants: roles,
      })),
      total,
      query,
    );
  }

  async detail(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        firstname: true,
        lastname: true,
        email: true,
        msisdn: true,
        status: true,
        createdAt: true,
        lastLoginAt: true,
        passwordChangedAt: true,
        mustChangePassword: true,
        playerProfile: { select: { avatarUrl: true, level: true, city: true } },
        roles: {
          select: {
            ...grantSelect,
            grantedBy: { select: { id: true, firstname: true, lastname: true } },
            role: { select: { id: true, key: true, name: true, scope: true, permissions: { select: { permissionKey: true } } } },
          },
          orderBy: [{ revokedAt: { sort: 'desc', nulls: 'first' } }, { grantedAt: 'desc' }],
        },
        _count: { select: { bookings: true, matchesAsPlayer1: true } },
      },
    });
    if (!user) throw new NotFoundException(t('errors.users.notFound'));
    const { roles, playerProfile, _count, ...rest } = user;
    return {
      ...rest,
      profile: playerProfile,
      stats: { bookings: _count.bookings, matchesRecorded: _count.matchesAsPlayer1 },
      grants: roles.map(({ role: { permissions, ...role }, ...grant }) => ({
        ...grant,
        role,
        permissions: permissions.map((p) => p.permissionKey).sort(),
      })),
    };
  }

  async setStatus(actor: { id: string; grants: readonly Grant[] }, id: string, dto: SetUserStatusDto) {
    if (id === actor.id) throw new BadRequestException(t('errors.admin.cannotChangeOwnStatus'));
    const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!user) throw new NotFoundException(t('errors.users.notFound'));
    await this.assertNotEscalating(actor.grants, id);
    if (user.status === dto.status) return this.detail(id);

    const ending = dto.status !== UserStatus.ACTIVE;
    await this.prisma.$transaction(
      async (tx) => {
        if (ending && (await this.isSuperAdmin(tx, id))) await this.grants.assertAnotherSuperAdmin(tx, id);
        await tx.user.update({
          where: { id },
          // Suspending or disabling ends every session at once.
          data: { status: dto.status, ...(ending ? { tokenVersion: { increment: 1 } } : {}) },
        });
        if (ending) {
          await tx.refreshToken.updateMany({ where: { userId: id, revoked: false }, data: { revoked: true } });
        }
        await this.audit.record(
          {
            actorId: actor.id,
            action: 'user.status.changed',
            entityType: 'User',
            entityId: id,
            before: { status: user.status },
            after: { status: dto.status },
            reason: dto.reason,
          },
          tx,
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return this.detail(id);
  }

  /**
   * Replaces the password with a one-time temporary one, shown once to the
   * administrator. The user must change it at next sign-in, and every current
   * session ends.
   */
  async resetPassword(actor: { id: string; grants: readonly Grant[] }, id: string) {
    if (id === actor.id) throw new BadRequestException(t('errors.admin.cannotResetOwnPassword'));
    const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!user) throw new NotFoundException(t('errors.users.notFound'));
    await this.assertNotEscalating(actor.grants, id);

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await bcrypt.hash(temporaryPassword, 10);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: {
          passwordHash,
          mustChangePassword: true,
          passwordChangedAt: new Date(),
          tokenVersion: { increment: 1 },
        },
      });
      await tx.refreshToken.updateMany({ where: { userId: id, revoked: false }, data: { revoked: true } });
      await this.audit.record(
        { actorId: actor.id, action: 'user.password.reset', entityType: 'User', entityId: id },
        tx,
      );
    });
    return { temporaryPassword };
  }

  /**
   * An administrator may only act on accounts whose rights they hold
   * themselves (globally), so a user manager can't take over a Super Admin.
   */
  private async assertNotEscalating(actorGrants: readonly Grant[], targetId: string) {
    const targetGrants = await this.authz.loadGrants(targetId);
    const needed = targetGrants.flatMap((grant) => [...grant.permissions]);
    if (missingFor(actorGrants, needed).length) throw escalation();
  }

  private async isSuperAdmin(tx: Prisma.TransactionClient, userId: string) {
    const count = await tx.userRole.count({
      where: { userId, revokedAt: null, role: { key: SUPER_ADMIN_ROLE_KEY } },
    });
    return count > 0;
  }
}

/** 12 characters meeting the password policy, without look-alike letters. */
export function generateTemporaryPassword(): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '!@#$%&*?'];
  const all = sets.join('');
  const chars = sets.map((set) => set[randomInt(set.length)]);
  while (chars.length < 12) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
