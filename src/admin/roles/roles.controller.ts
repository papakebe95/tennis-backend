import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/jwt.strategy.js';
import { Authorize } from '../../authz/permission.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { CreateRoleDto, RolePermissionsDto, UpdateRoleDto } from './roles.dto.js';
import { RolesService } from './roles.service.js';

@Controller('admin')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  /** Read-only: permissions are defined in code (src/authz/permissions.ts). */
  @Get('permissions')
  @Authorize('role.view')
  catalog() {
    return this.roles.catalog();
  }

  @Get('roles')
  // Also needed to pick a role when assigning one (club admins included).
  @Authorize('user.roles.assign', { anywhere: true })
  list() {
    return this.roles.list();
  }

  @Get('roles/:id')
  @Authorize('role.view')
  findOne(@Param('id') id: string) {
    return this.roles.findOne(id);
  }

  @Post('roles')
  @Authorize('role.manage')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateRoleDto) {
    return this.roles.create(user.userId, dto);
  }

  @Patch('roles/:id')
  @Authorize('role.manage')
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.roles.update(user.userId, id, dto);
  }

  @Put('roles/:id/permissions')
  @Authorize('role.manage')
  setPermissions(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: RolePermissionsDto) {
    return this.roles.setPermissions(user.userId, id, dto.permissions);
  }

  @Delete('roles/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authorize('role.manage')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.roles.remove(user.userId, id);
  }
}
