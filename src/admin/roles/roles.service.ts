import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RoleScope } from '@prisma/client';
import { AuditService } from '../../audit/audit.service.js';
import { isPermissionKey, PERMISSIONS } from '../../authz/permissions.js';
import { t, type MessageKey } from '../../i18n/i18n.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { CreateRoleDto, UpdateRoleDto } from './roles.dto.js';

const roleSelect = {
  id: true,
  key: true,
  name: true,
  description: true,
  scope: true,
  organizationType: true,
  isSystem: true,
  selfRegistrable: true,
  createdAt: true,
  updatedAt: true,
  permissions: { select: { permissionKey: true } },
  _count: { select: { grants: { where: { revokedAt: null } } } },
} satisfies Prisma.RoleSelect;

type RoleRow = Prisma.RoleGetPayload<{ select: typeof roleSelect }>;

const toView = ({ permissions, _count, ...role }: RoleRow) => ({
  ...role,
  permissions: permissions.map((p) => p.permissionKey).sort(),
  activeGrants: _count.grants,
});

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The code-defined catalog, with the roles carrying each permission. */
  async catalog() {
    const roles = await this.prisma.role.findMany({
      select: { id: true, key: true, name: true, permissions: { select: { permissionKey: true } } },
      orderBy: { name: 'asc' },
    });
    return Object.entries(PERMISSIONS).map(([key, definition]) => ({
      key,
      ...definition,
      // In the caller's language; the code catalog holds the English text.
      description: t(`permissions.${key.replace(/\./g, '_')}` as MessageKey),
      roles: roles
        .filter((role) => role.permissions.some((p) => p.permissionKey === key))
        .map(({ id, key: roleKey, name }) => ({ id, key: roleKey, name })),
    }));
  }

  async list() {
    const rows = await this.prisma.role.findMany({
      select: roleSelect,
      orderBy: [{ isSystem: 'desc' }, { scope: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toView);
  }

  async findOne(id: string) {
    const row = await this.prisma.role.findUnique({ where: { id }, select: roleSelect });
    if (!row) throw new NotFoundException(t('errors.admin.roleNotFound'));
    return toView(row);
  }

  async create(actorId: string, dto: CreateRoleDto) {
    const permissions = validatePermissions(dto.permissions, dto.scope);
    if (await this.prisma.role.findUnique({ where: { key: dto.key } })) {
      throw new ConflictException(t('errors.admin.roleKeyTaken'));
    }
    const role = await this.prisma.$transaction(async (tx) => {
      const created = await tx.role.create({
        data: {
          key: dto.key,
          name: dto.name,
          description: dto.description,
          scope: dto.scope,
          organizationType: dto.scope === RoleScope.ORGANIZATION ? dto.organizationType : null,
          selfRegistrable: dto.selfRegistrable ?? false,
          permissions: { create: permissions.map((permissionKey) => ({ permissionKey })) },
        },
      });
      await this.audit.record(
        {
          actorId,
          action: 'role.created',
          entityType: 'Role',
          entityId: created.id,
          after: {
            key: dto.key,
            name: dto.name,
            description: dto.description,
            scope: dto.scope,
            organizationType: dto.organizationType,
            selfRegistrable: dto.selfRegistrable,
            permissions,
          },
        },
        tx,
      );
      return created;
    });
    return this.findOne(role.id);
  }

  async update(actorId: string, id: string, dto: UpdateRoleDto) {
    const role = await this.findEditable(id);
    const scope = dto.scope ?? role.scope;
    if (scope !== role.scope) {
      if (role.activeGrants > 0) throw new ConflictException(t('errors.admin.roleScopeLocked'));
      validatePermissions(role.permissions, scope);
    }
    const data = {
      name: dto.name,
      description: dto.description,
      selfRegistrable: dto.selfRegistrable,
      scope,
      organizationType:
        scope !== RoleScope.ORGANIZATION ? null : dto.organizationType !== undefined ? dto.organizationType : undefined,
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.role.update({ where: { id }, data });
      await this.audit.record(
        {
          actorId,
          action: 'role.updated',
          entityType: 'Role',
          entityId: id,
          before: pick(role, Object.keys(dto)),
          after: dto,
        },
        tx,
      );
    });
    return this.findOne(id);
  }

  async setPermissions(actorId: string, id: string, requested: string[]) {
    const role = await this.findEditable(id);
    const permissions = validatePermissions(requested, role.scope);
    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      await tx.rolePermission.createMany({
        data: permissions.map((permissionKey) => ({ roleId: id, permissionKey })),
      });
      await this.audit.record(
        {
          actorId,
          action: 'role.permissions.changed',
          entityType: 'Role',
          entityId: id,
          before: { permissions: role.permissions },
          after: { permissions },
        },
        tx,
      );
    });
    return this.findOne(id);
  }

  async remove(actorId: string, id: string) {
    const role = await this.findEditable(id);
    const openRequests = await this.prisma.accessRequest.count({
      where: { roleId: id, status: { in: ['PENDING', 'INFO_REQUESTED'] } },
    });
    if (role.activeGrants > 0 || openRequests > 0) {
      throw new ConflictException(
        t('errors.admin.roleInUse', { count: role.activeGrants + openRequests }),
      );
    }
    await this.prisma.$transaction(async (tx) => {
      // Revoked grants keep history but block the FK; they go with the role.
      await tx.userRole.deleteMany({ where: { roleId: id } });
      await tx.accessRequest.deleteMany({ where: { roleId: id } });
      await tx.role.delete({ where: { id } });
      await this.audit.record(
        { actorId, action: 'role.deleted', entityType: 'Role', entityId: id, before: role },
        tx,
      );
    });
  }

  private async findEditable(id: string) {
    const role = await this.findOne(id);
    if (role.isSystem) {
      throw new ForbiddenException({ message: t('errors.admin.roleSystem'), code: 'SYSTEM_ROLE' });
    }
    return role;
  }
}

/** Known, deduplicated permissions that make sense at `scope`. */
export function validatePermissions(requested: readonly string[], scope: RoleScope): string[] {
  const unique = [...new Set(requested)];
  for (const permission of unique) {
    if (!isPermissionKey(permission)) {
      throw new BadRequestException(t('errors.admin.unknownPermission', { permission }));
    }
    if (!(PERMISSIONS[permission].scopes as readonly RoleScope[]).includes(scope)) {
      throw new BadRequestException(t('errors.admin.permissionScope', { permission, scope }));
    }
  }
  return unique.sort();
}

const pick = (source: object, keys: string[]) =>
  Object.fromEntries(Object.entries(source).filter(([key]) => keys.includes(key)));
