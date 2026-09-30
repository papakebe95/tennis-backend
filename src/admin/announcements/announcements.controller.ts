import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { AuthenticatedUser } from '../../auth/jwt.strategy.js';
import { Authorize } from '../../authz/permission.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { AnnouncementsService } from './announcements.service.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class AnnouncementDto {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(120) title!: string;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(1000) body!: string;
  /** Tournament announcements: one table only. */
  @IsOptional() @IsString() eventId?: string;
}

@Controller('admin')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get('tournaments/:id/announcements')
  @Authorize('tournament.view', { resource: 'competition' })
  tournamentList(@Param('id') id: string) {
    return this.announcements.list({ kind: 'tournament', competitionId: id });
  }

  @Post('tournaments/:id/announcements')
  @Authorize('tournament.announce', { resource: 'competition' })
  tournamentSend(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: AnnouncementDto) {
    return this.announcements.send(user.userId, { kind: 'tournament', competitionId: id, eventId: dto.eventId ?? null }, dto);
  }

  @Get('clubs/:id/announcements')
  @Authorize('notification.broadcast', { resource: 'club' })
  clubList(@Param('id') id: string) {
    return this.announcements.list({ kind: 'club', clubId: id });
  }

  @Post('clubs/:id/announcements')
  @Authorize('notification.broadcast', { resource: 'club' })
  clubSend(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: AnnouncementDto) {
    return this.announcements.send(user.userId, { kind: 'club', clubId: id }, dto);
  }

  @Get('federations/:id/announcements')
  @Authorize('notification.broadcast', { resource: 'organization' })
  federationList(@Param('id') id: string) {
    return this.announcements.list({ kind: 'federation', federationId: id });
  }

  @Post('federations/:id/announcements')
  @Authorize('notification.broadcast', { resource: 'organization' })
  federationSend(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: AnnouncementDto) {
    return this.announcements.send(user.userId, { kind: 'federation', federationId: id }, dto);
  }
}
