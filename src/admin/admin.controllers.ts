import { Controller, Get, Query } from '@nestjs/common';
import { OrganizationType, Prisma } from '@prisma/client';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { Authorize, CurrentGrants } from '../authz/permission.guard.js';
import { scopeFilter, type Grant } from '../authz/scope.js';
import { searchText } from '../common/pagination.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogsService, ListAuditLogsQueryDto } from './audit-logs/audit-logs.service.js';
import { DashboardService } from './dashboard/dashboard.service.js';

@Controller('admin/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @Authorize('dashboard.global.view')
  global() {
    return this.dashboard.global();
  }
}

@Controller('admin/audit-logs')
export class AuditLogsController {
  constructor(private readonly logs: AuditLogsService) {}

  @Get()
  @Authorize('audit.view', { anywhere: true })
  list(@CurrentGrants() grants: Grant[], @Query() query: ListAuditLogsQueryDto) {
    return this.logs.list(scopeFilter(grants, 'audit.view'), query);
  }

  @Get('facets')
  @Authorize('audit.view', { anywhere: true })
  facets(@CurrentGrants() grants: Grant[]) {
    return this.logs.facets(scopeFilter(grants, 'audit.view'));
  }
}

class LookupQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsIn(Object.values(OrganizationType))
  type?: OrganizationType;
}

/**
 * Small pickers for the role-assignment form, limited to where the caller
 * may assign roles.
 */
@Controller('admin/lookups')
export class LookupsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('organizations')
  @Authorize('user.roles.assign', { anywhere: true })
  organizations(@CurrentGrants() grants: Grant[], @Query() query: LookupQueryDto) {
    const scope = scopeFilter(grants, 'user.roles.assign');
    const q = searchText(query.q);
    return this.prisma.organization.findMany({
      where: {
        type: query.type,
        ...(scope.global ? {} : { id: { in: scope.organizationIds } }),
        ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
      },
      orderBy: { name: 'asc' },
      take: 20,
      select: { id: true, name: true, type: true, status: true },
    });
  }

  @Get('competitions')
  @Authorize('user.roles.assign', { anywhere: true })
  competitions(@CurrentGrants() grants: Grant[], @Query() query: LookupQueryDto) {
    const scope = scopeFilter(grants, 'user.roles.assign');
    const q = searchText(query.q);
    const visible: Prisma.CompetitionWhereInput = scope.global
      ? {}
      : {
          OR: [
            { id: { in: scope.competitionIds } },
            { hostOrganizationId: { in: scope.organizationIds } },
          ],
        };
    return this.prisma.competition.findMany({
      where: { AND: [visible, q ? { name: { contains: q, mode: 'insensitive' } } : {}] },
      orderBy: { startDate: 'desc' },
      take: 20,
      select: { id: true, name: true, startDate: true, club: { select: { name: true } } },
    });
  }
}
