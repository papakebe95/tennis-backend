import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../auth/jwt.strategy.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { ClubMembershipService } from './club-membership.service.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class MembershipRequestDto {
  /** Plan the player would like (the club decides). */
  @IsOptional() @IsString() planId?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) message?: string;
}

export class LeaveClubDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) reason?: string;
}

/** Club membership for the signed-in player (mobile app). */
@Controller()
@UseGuards(JwtAuthGuard)
export class ClubMembershipController {
  constructor(private readonly membership: ClubMembershipService) {}

  @Get('users/me/clubs')
  myClubs(@CurrentUser() user: AuthenticatedUser) {
    return this.membership.myClubs(user.userId);
  }

  @Get('clubs/:id/membership')
  status(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.membership.status(user.userId, id);
  }

  @Post('clubs/:id/membership-requests')
  request(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: MembershipRequestDto) {
    return this.membership.request(user.userId, id, dto);
  }

  @Delete('clubs/:id/membership-requests/mine')
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.membership.cancel(user.userId, id);
  }

  @Post('clubs/:id/membership/leave')
  leave(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: LeaveClubDto) {
    return this.membership.leave(user.userId, id, dto.reason);
  }
}
