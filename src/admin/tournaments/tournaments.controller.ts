import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../../auth/jwt.strategy.js';
import { Authorize, CurrentGrants } from '../../authz/permission.guard.js';
import type { Grant } from '../../authz/scope.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { EventsService } from './events.service.js';
import { RegistrationsService, type Decision } from './registrations.service.js';
import { SportProfilesService } from './sport-profiles.service.js';
import {
  CreateEntryDto,
  CreateEventDto,
  CreateTournamentDto,
  DecisionDto,
  EntryCandidatesQueryDto,
  EventDto,
  InterruptDto,
  ListRegistrationsQueryDto,
  ListTournamentsQueryDto,
  ResumeDto,
  SeedDto,
  SportProfileDto,
  StaffGrantDto,
  StaffRevokeQueryDto,
  TournamentDto,
  TransitionDto,
} from './tournaments.dto.js';
import { TournamentsService } from './tournaments.service.js';

/** Tournaments ("competitions" in the data model); `:id` is the tournament. */
@Controller('admin/tournaments')
export class AdminTournamentsController {
  constructor(
    private readonly tournaments: TournamentsService,
    private readonly events: EventsService,
  ) {}

  @Get()
  @Authorize('tournament.view', { anywhere: true })
  list(@CurrentGrants() grants: Grant[], @Query() query: ListTournamentsQueryDto) {
    return this.tournaments.list(grants, query);
  }

  @Get('host-options')
  @Authorize('tournament.create', { anywhere: true })
  hostOptions(@CurrentGrants() grants: Grant[]) {
    return this.tournaments.hostOptions(grants);
  }

  @Post()
  @Authorize('tournament.create', { anywhere: true })
  create(@CurrentGrants() grants: Grant[], @CurrentUser() user: AuthenticatedUser, @Body() dto: CreateTournamentDto) {
    return this.tournaments.create(grants, user.userId, dto);
  }

  @Get(':id')
  @Authorize('tournament.view', { resource: 'competition' })
  detail(@Param('id') id: string) {
    return this.tournaments.detail(id);
  }

  @Patch(':id')
  @Authorize('tournament.update', { resource: 'competition' })
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: TournamentDto) {
    return this.tournaments.update(user.userId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authorize('tournament.delete', { resource: 'competition' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.tournaments.remove(user.userId, id);
  }

  @Post(':id/transitions')
  @Authorize('tournament.lifecycle.manage', { resource: 'competition' })
  transition(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: TransitionDto) {
    return this.tournaments.transition(user.userId, id, dto);
  }

  @Post(':id/interrupt')
  @Authorize('tournament.interrupt', { resource: 'competition' })
  interrupt(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: InterruptDto) {
    return this.tournaments.interrupt(user.userId, id, dto);
  }

  @Post(':id/resume')
  @Authorize('tournament.interrupt', { resource: 'competition' })
  resume(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: ResumeDto) {
    return this.tournaments.resume(user.userId, id, dto);
  }

  @Post(':id/events')
  @Authorize('tournament.update', { resource: 'competition' })
  createEvent(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: CreateEventDto) {
    return this.events.create(user.userId, id, dto);
  }

  @Get(':id/staff')
  @Authorize('tournament.view', { resource: 'competition' })
  staff(@Param('id') id: string) {
    return this.tournaments.staff(id);
  }

  @Get(':id/staff-candidates')
  @Authorize('tournament.staff.manage', { resource: 'competition' })
  staffCandidates(@Param('id') id: string, @Query() query: EntryCandidatesQueryDto) {
    return this.tournaments.staffCandidates(id, query.q);
  }

  @Post(':id/staff')
  @Authorize('tournament.staff.manage', { resource: 'competition' })
  addStaff(
    @CurrentGrants() grants: Grant[],
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: StaffGrantDto,
  ) {
    return this.tournaments.addStaff(grants, user.userId, id, dto);
  }

  @Delete(':id/staff/:grantId')
  @Authorize('tournament.staff.manage', { resource: 'competition' })
  removeStaff(
    @CurrentGrants() grants: Grant[],
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('grantId') grantId: string,
    @Query() query: StaffRevokeQueryDto,
  ) {
    return this.tournaments.removeStaff(grants, user.userId, id, grantId, query.reason);
  }
}

/** One table of a tournament; `:id` is the event. */
@Controller('admin/events')
export class AdminEventsController {
  constructor(
    private readonly events: EventsService,
    private readonly registrations: RegistrationsService,
  ) {}

  @Patch(':id')
  @Authorize('tournament.update', { resource: 'event' })
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: EventDto) {
    return this.events.update(user.userId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authorize('tournament.update', { resource: 'event' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.events.remove(user.userId, id);
  }

  @Get(':id/registrations')
  @Authorize('registration.view', { resource: 'event' })
  registrationsList(@Param('id') id: string, @Query() query: ListRegistrationsQueryDto) {
    return this.registrations.list(id, query);
  }

  @Get(':id/entry-candidates')
  @Authorize('registration.manage', { resource: 'event' })
  candidates(@Param('id') id: string, @Query() query: EntryCandidatesQueryDto) {
    return this.registrations.candidates(id, query.q);
  }

  @Get(':id/qualifier-sources')
  @Authorize('registration.view', { resource: 'event' })
  qualifierSources(@Param('id') id: string) {
    return this.registrations.qualifierSources(id);
  }

  @Post(':id/registrations')
  @Authorize('registration.manage', { resource: 'event' })
  addEntry(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: CreateEntryDto) {
    return this.registrations.create(user.userId, id, dto);
  }
}

/** One entry; `:id` is the registration. */
@Controller('admin/registrations')
export class AdminRegistrationsController {
  constructor(private readonly registrations: RegistrationsService) {}

  private decide(user: AuthenticatedUser, id: string, decision: Decision, dto: DecisionDto) {
    return this.registrations.decide(user.userId, id, decision, dto);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authorize('registration.manage', { resource: 'registration' })
  approve(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: DecisionDto) {
    return this.decide(user, id, 'approve', dto);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authorize('registration.manage', { resource: 'registration' })
  reject(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: DecisionDto) {
    return this.decide(user, id, 'reject', dto);
  }

  @Post(':id/waitlist')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authorize('registration.manage', { resource: 'registration' })
  waitlist(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: DecisionDto) {
    return this.decide(user, id, 'waitlist', dto);
  }

  @Post(':id/withdraw')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authorize('registration.manage', { resource: 'registration' })
  withdraw(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: DecisionDto) {
    return this.decide(user, id, 'withdraw', dto);
  }

  @Patch(':id/seed')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authorize('registration.manage', { resource: 'registration' })
  seed(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: SeedDto) {
    return this.registrations.setSeed(user.userId, id, dto.seed ?? null);
  }
}

@Controller('admin')
export class SportProfilesController {
  constructor(private readonly sportProfiles: SportProfilesService) {}

  /** Reference data for any signed-in back-office user. */
  @Get('classifications')
  @UseGuards(JwtAuthGuard)
  classifications() {
    return this.sportProfiles.classifications();
  }

  /**
   * A federation power over any player: players aren't owned by one
   * organization, so the permission is checked wherever it is held.
   */
  @Patch('players/:userId/sport-profile')
  @Authorize('player.sport_profile.manage', { anywhere: true })
  update(@CurrentUser() user: AuthenticatedUser, @Param('userId') userId: string, @Body() dto: SportProfileDto) {
    return this.sportProfiles.update(user.userId, userId, dto);
  }
}
