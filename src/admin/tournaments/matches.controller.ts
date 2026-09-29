import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/jwt.strategy.js';
import { Authorize, CurrentGrants } from '../../authz/permission.guard.js';
import type { Grant } from '../../authz/scope.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import {
  ListMatchesQueryDto,
  MatchOfficialDto,
  MatchReasonDto,
  MatchResultDto,
  ScheduleMatchDto,
  ScheduleQueryDto,
  TournamentCourtsDto,
} from './matches.dto.js';
import { MatchesService } from './matches.service.js';

/** Tournament matches; `:id` is the match. */
@Controller('admin/matches')
export class AdminMatchesController {
  constructor(private readonly matches: MatchesService) {}

  @Get()
  @Authorize('match.view', { anywhere: true })
  list(@CurrentGrants() grants: Grant[], @CurrentUser() user: AuthenticatedUser, @Query() query: ListMatchesQueryDto) {
    return this.matches.list(grants, user.userId, query);
  }

  @Get(':id')
  @Authorize('match.view', { resource: 'match' })
  detail(@CurrentGrants() grants: Grant[], @CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.matches.detail(grants, user.userId, id);
  }

  @Patch(':id/schedule')
  @Authorize('match.schedule', { resource: 'match' })
  schedule(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: ScheduleMatchDto) {
    return this.matches.schedule(user.userId, id, dto);
  }

  @Delete(':id/schedule')
  @Authorize('match.schedule', { resource: 'match' })
  unschedule(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.matches.unschedule(user.userId, id);
  }

  @Patch(':id/official')
  @Authorize('match.schedule', { resource: 'match' })
  official(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: MatchOfficialDto) {
    return this.matches.assignOfficial(user.userId, id, dto.userId ?? null);
  }

  @Post(':id/start')
  @Authorize('match.result.enter', { resource: 'match' })
  start(@CurrentGrants() grants: Grant[], @CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.matches.start(grants, user.userId, id);
  }

  @Post(':id/postpone')
  @Authorize('match.status.manage', { resource: 'match' })
  postpone(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: MatchReasonDto) {
    return this.matches.postpone(user.userId, id, dto.reason);
  }

  @Post(':id/result')
  @Authorize('match.result.enter', { resource: 'match' })
  result(@CurrentGrants() grants: Grant[], @CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: MatchResultDto) {
    return this.matches.enterResult(grants, user.userId, id, dto);
  }

  @Post(':id/result/validate')
  @Authorize('match.result.validate', { resource: 'match' })
  validate(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.matches.validate(user.userId, id);
  }

  @Post(':id/result/dispute')
  @Authorize('match.status.manage', { resource: 'match' })
  dispute(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: MatchReasonDto) {
    return this.matches.dispute(user.userId, id, dto.reason);
  }
}

/** A tournament's schedule, courts and officials; `:id` is the tournament. */
@Controller('admin/tournaments/:id')
export class TournamentScheduleController {
  constructor(private readonly matches: MatchesService) {}

  @Get('schedule')
  @Authorize('match.view', { resource: 'competition' })
  schedule(@CurrentGrants() grants: Grant[], @CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Query() query: ScheduleQueryDto) {
    return this.matches.scheduleDay(grants, user.userId, id, query.date);
  }

  @Get('officials')
  @Authorize('match.schedule', { resource: 'competition' })
  officials(@Param('id') id: string) {
    return this.matches.officials(id);
  }

  @Get('courts')
  @Authorize('tournament.view', { resource: 'competition' })
  courts(@Param('id') id: string) {
    return this.matches.courtOptions(id);
  }

  @Put('courts')
  @Authorize('tournament.update', { resource: 'competition' })
  setCourts(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: TournamentCourtsDto) {
    return this.matches.setCourts(user.userId, id, dto.courtIds);
  }
}
