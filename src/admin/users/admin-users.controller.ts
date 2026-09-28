import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/jwt.strategy.js';
import { Authorize, CurrentGrants } from '../../authz/permission.guard.js';
import type { Grant } from '../../authz/scope.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { GrantRoleDto, ListUsersQueryDto, RevokeRoleDto, SetUserStatusDto } from './admin-users.dto.js';
import { AdminUsersService } from './admin-users.service.js';
import { RoleGrantsService } from './role-grants.service.js';

@Controller('admin/users')
export class AdminUsersController {
  constructor(
    private readonly users: AdminUsersService,
    private readonly grants: RoleGrantsService,
  ) {}

  @Get()
  @Authorize('user.view')
  list(@Query() query: ListUsersQueryDto) {
    return this.users.list(query);
  }

  @Get(':id')
  @Authorize('user.view')
  detail(@Param('id') id: string) {
    return this.users.detail(id);
  }

  @Patch(':id/status')
  @Authorize('user.status.manage')
  setStatus(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentGrants() grants: Grant[],
    @Param('id') id: string,
    @Body() dto: SetUserStatusDto,
  ) {
    return this.users.setStatus({ id: user.userId, grants }, id, dto);
  }

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  @Authorize('user.password.reset')
  resetPassword(@CurrentUser() user: AuthenticatedUser, @CurrentGrants() grants: Grant[], @Param('id') id: string) {
    return this.users.resetPassword({ id: user.userId, grants }, id);
  }

  // Scoped: a club admin may grant club roles in their own club. The scope
  // is checked in RoleGrantsService against the requested organization or
  // competition, so the guard only asks for the permission somewhere.
  @Post(':id/roles')
  @Authorize('user.roles.assign', { anywhere: true })
  grant(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentGrants() grants: Grant[],
    @Param('id') id: string,
    @Body() dto: GrantRoleDto,
  ) {
    // Returns the grant only: the caller may not have `user.view`.
    return this.grants.grant(grants, user.userId, id, dto);
  }

  @Delete(':id/roles/:grantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authorize('user.roles.assign', { anywhere: true })
  revoke(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentGrants() grants: Grant[],
    @Param('id') id: string,
    @Param('grantId') grantId: string,
    @Body() dto: RevokeRoleDto,
  ) {
    return this.grants.revoke(grants, user.userId, id, grantId, dto.reason);
  }
}
