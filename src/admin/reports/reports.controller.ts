import { Controller, ForbiddenException, Get, Param, Query, Res } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDate, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import type { Response } from 'express';
import { AuthzService } from '../../authz/authz.service.js';
import { Authorize, CurrentGrants } from '../../authz/permission.guard.js';
import { holds, type Grant } from '../../authz/scope.js';
import { PageQueryDto } from '../../common/pagination.js';
import { t } from '../../i18n/i18n.js';
import { RankingsService } from './rankings.service.js';
import { CLUB_REPORTS, FEDERATION_REPORTS, ReportsService, TOURNAMENT_REPORTS, type Report } from './reports.service.js';

class ReportQueryDto {
  @IsOptional() @Type(() => Date) @IsDate() from?: Date;
  @IsOptional() @Type(() => Date) @IsDate() to?: Date;
  /** csv also needs report.export. */
  @IsOptional() @IsIn(['json', 'csv']) format?: 'json' | 'csv';
}
class ClubReportQueryDto extends ReportQueryDto {
  @IsIn(CLUB_REPORTS) type!: (typeof CLUB_REPORTS)[number];
}
class TournamentReportQueryDto extends ReportQueryDto {
  @IsIn(TOURNAMENT_REPORTS) type!: (typeof TOURNAMENT_REPORTS)[number];
}
class FederationReportQueryDto extends ReportQueryDto {
  @IsIn(FEDERATION_REPORTS) type!: (typeof FEDERATION_REPORTS)[number];
}
class RankingQueryDto extends PageQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(2000) @Max(2100) season?: number;
  @IsOptional() @IsIn(['json', 'csv']) format?: 'json' | 'csv';
}

@Controller('admin')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly rankings: RankingsService,
    private readonly authz: AuthzService,
  ) {}

  @Get('reports/clubs/:id')
  @Authorize('report.view', { resource: 'club' })
  async club(@CurrentGrants() grants: Grant[], @Param('id') id: string, @Query() query: ClubReportQueryDto, @Res({ passthrough: true }) res: Response) {
    const { from, to } = this.reports.period(query.from, query.to);
    return this.output(grants, 'club', id, await this.reports.club(id, query.type, from, to), query.format, res);
  }

  @Get('reports/tournaments/:id')
  @Authorize('report.view', { resource: 'competition' })
  async tournament(@CurrentGrants() grants: Grant[], @Param('id') id: string, @Query() query: TournamentReportQueryDto, @Res({ passthrough: true }) res: Response) {
    return this.output(grants, 'competition', id, await this.reports.tournament(id, query.type), query.format, res);
  }

  @Get('reports/federations/:id')
  @Authorize('report.view', { resource: 'organization' })
  async federation(@CurrentGrants() grants: Grant[], @Param('id') id: string, @Query() query: FederationReportQueryDto, @Res({ passthrough: true }) res: Response) {
    const { from, to } = this.reports.period(query.from, query.to);
    return this.output(grants, 'organization', id, await this.reports.federation(id, query.type, from, to), query.format, res);
  }

  @Get('federations/:id/rankings')
  @Authorize('federation.rankings.view', { resource: 'organization' })
  async ranking(@Param('id') id: string, @Query() query: RankingQueryDto, @Res({ passthrough: true }) res: Response) {
    const season = query.season ?? new Date().getUTCFullYear();
    if (query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="ranking-${season}.csv"`);
      return this.rankings.federationCsv(id, season);
    }
    return this.rankings.federation(id, { season, q: query.q, page: query.page, pageSize: query.pageSize });
  }

  private async output(grants: Grant[], resource: 'club' | 'competition' | 'organization', id: string, report: Report, format: string | undefined, res: Response) {
    if (format !== 'csv') return report;
    if (!holds(grants, 'report.export', await this.authz.scopeChain(resource, id))) {
      throw new ForbiddenException({ message: t('errors.http.forbidden'), code: 'FORBIDDEN' });
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${report.type}-${new Date().toISOString().slice(0, 10)}.csv"`);
    return this.reports.csv(report);
  }
}
