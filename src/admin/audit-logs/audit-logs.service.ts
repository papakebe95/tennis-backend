import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsString, MaxLength } from 'class-validator';
import type { ScopeFilter } from '../../authz/scope.js';
import { pageArgs, PageQueryDto, searchText, toPage } from '../../common/pagination.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export class ListAuditLogsQueryDto extends PageQueryDto {
  @IsOptional() @IsString() actorId?: string;
  @IsOptional() @IsString() @MaxLength(60) entityType?: string;
  @IsOptional() @IsString() entityId?: string;
  @IsOptional() @IsString() organizationId?: string;
  @IsOptional() @IsString() competitionId?: string;
  /** Exact action, or a prefix ending with "." ("user." → every user action). */
  @IsOptional() @IsString() @MaxLength(80) action?: string;
  @IsOptional() @Type(() => Date) @IsDate() from?: Date;
  @IsOptional() @Type(() => Date) @IsDate() to?: Date;
}

@Injectable()
export class AuditLogsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Audit rows the caller may read: everything with a global grant, otherwise
   * only rows recorded in their organizations or competitions.
   */
  async list(scope: ScopeFilter, query: ListAuditLogsQueryDto) {
    const q = searchText(query.q);
    const visible: Prisma.AuditLogWhereInput = scope.global
      ? {}
      : {
          OR: [
            { organizationId: { in: scope.organizationIds } },
            { competitionId: { in: scope.competitionIds } },
          ],
        };
    const where: Prisma.AuditLogWhereInput = {
      AND: [
        visible,
        {
          actorId: query.actorId,
          entityType: query.entityType,
          entityId: query.entityId,
          organizationId: query.organizationId,
          competitionId: query.competitionId,
          ...(query.action
            ? { action: query.action.endsWith('.') ? { startsWith: query.action } : query.action }
            : {}),
          ...(query.from || query.to ? { createdAt: { gte: query.from, lte: query.to } } : {}),
          ...(q
            ? {
                OR: [
                  { action: { contains: q, mode: 'insensitive' } },
                  { reason: { contains: q, mode: 'insensitive' } },
                  { actor: { lastname: { contains: q, mode: 'insensitive' } } },
                  { actor: { firstname: { contains: q, mode: 'insensitive' } } },
                ],
              }
            : {}),
        },
      ],
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        ...pageArgs(query),
        orderBy: { createdAt: query.sort === 'createdAt:asc' ? 'asc' : 'desc' },
        include: {
          actor: { select: { id: true, firstname: true, lastname: true } },
          organization: { select: { id: true, name: true } },
          competition: { select: { id: true, name: true } },
        },
      }),
    ]);
    return toPage(items, total, query);
  }

  /** Distinct actions and entity types, for the filter dropdowns. */
  async facets(scope: ScopeFilter) {
    const where: Prisma.AuditLogWhereInput = scope.global
      ? {}
      : { OR: [{ organizationId: { in: scope.organizationIds } }, { competitionId: { in: scope.competitionIds } }] };
    const [actions, entityTypes] = await Promise.all([
      this.prisma.auditLog.findMany({ where, distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } }),
      this.prisma.auditLog.findMany({ where, distinct: ['entityType'], select: { entityType: true }, orderBy: { entityType: 'asc' } }),
    ]);
    return { actions: actions.map((a) => a.action), entityTypes: entityTypes.map((e) => e.entityType) };
  }
}
