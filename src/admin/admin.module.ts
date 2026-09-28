import { Module } from '@nestjs/common';
import {
  AccessRequestsController,
  AdminAccessRequestsController,
} from '../access-requests/access-requests.controller.js';
import { AccessRequestsService } from '../access-requests/access-requests.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { AuditLogsController, DashboardController, LookupsController } from './admin.controllers.js';
import { AuditLogsService } from './audit-logs/audit-logs.service.js';
import { DashboardService } from './dashboard/dashboard.service.js';
import { RolesController } from './roles/roles.controller.js';
import { RolesService } from './roles/roles.service.js';
import { AdminUsersController } from './users/admin-users.controller.js';
import { AdminUsersService } from './users/admin-users.service.js';
import { RoleGrantsService } from './users/role-grants.service.js';

/** The back-office platform administration API (/admin/*, /access-requests). */
@Module({
  imports: [NotificationsModule],
  controllers: [
    AdminUsersController,
    RolesController,
    AccessRequestsController,
    AdminAccessRequestsController,
    DashboardController,
    AuditLogsController,
    LookupsController,
  ],
  providers: [
    AdminUsersService,
    RoleGrantsService,
    RolesService,
    AccessRequestsService,
    DashboardService,
    AuditLogsService,
  ],
  exports: [AccessRequestsService, RoleGrantsService],
})
export class AdminModule {}
