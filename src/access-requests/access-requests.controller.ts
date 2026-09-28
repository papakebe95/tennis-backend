import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AllowRestricted, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../auth/jwt.strategy.js';
import { Authorize, CurrentGrants } from '../authz/permission.guard.js';
import type { Grant } from '../authz/scope.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import {
  CreateAccessRequestDto,
  ListAccessRequestsQueryDto,
  OrganizationSearchQueryDto,
  RequestInfoDto,
  RespondAccessRequestDto,
  ReviewDecisionDto,
} from './access-requests.dto.js';
import { AccessRequestsService } from './access-requests.service.js';

/** Applicant side. Registration itself is POST /auth/register-applicant. */
@Controller('access-requests')
@UseGuards(ThrottlerGuard)
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class AccessRequestsController {
  constructor(private readonly requests: AccessRequestsService) {}

  /** Public: profiles offered at registration, countries and cities. */
  @Get('options')
  options() {
    return this.requests.options();
  }

  /** Public: organizations an applicant may ask to administer. */
  @Get('organizations')
  organizations(@Query() query: OrganizationSearchQueryDto) {
    return this.requests.searchOrganizations(query.type, query.q);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  @AllowRestricted()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateAccessRequestDto) {
    return this.requests.create(user.userId, dto);
  }

  @Get('mine')
  @UseGuards(JwtAuthGuard)
  @AllowRestricted()
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.requests.mine(user.userId);
  }

  @Patch(':id/respond')
  @UseGuards(JwtAuthGuard)
  @AllowRestricted()
  respond(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: RespondAccessRequestDto) {
    return this.requests.respond(user.userId, id, dto.response);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @AllowRestricted()
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.requests.cancel(user.userId, id);
  }
}

@Controller('admin/access-requests')
export class AdminAccessRequestsController {
  constructor(private readonly requests: AccessRequestsService) {}

  @Get()
  @Authorize('access_request.review')
  list(@Query() query: ListAccessRequestsQueryDto) {
    return this.requests.list(query);
  }

  @Get(':id')
  @Authorize('access_request.review')
  detail(@Param('id') id: string) {
    return this.requests.detail(id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @Authorize('access_request.review')
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentGrants() grants: Grant[],
    @Param('id') id: string,
    @Body() dto: ReviewDecisionDto,
  ) {
    return this.requests.approve({ id: user.userId, grants }, id, dto.reason);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @Authorize('access_request.review')
  reject(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: ReviewDecisionDto) {
    return this.requests.reject(user.userId, id, dto.reason);
  }

  @Post(':id/request-info')
  @HttpCode(HttpStatus.OK)
  @Authorize('access_request.review')
  requestInfo(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: RequestInfoDto) {
    return this.requests.requestInfo(user.userId, id, dto.message);
  }
}
