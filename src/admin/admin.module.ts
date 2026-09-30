import { Module } from '@nestjs/common';
import {
  AccessRequestsController,
  AdminAccessRequestsController,
} from '../access-requests/access-requests.controller.js';
import { AccessRequestsService } from '../access-requests/access-requests.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { AuditLogsController, DashboardController, LookupsController } from './admin.controllers.js';
import { AnnouncementsController } from './announcements/announcements.controller.js';
import { AnnouncementsService } from './announcements/announcements.service.js';
import { AuditLogsService } from './audit-logs/audit-logs.service.js';
import { RankingsService } from './reports/rankings.service.js';
import { ReportsController } from './reports/reports.controller.js';
import { ReportsService } from './reports/reports.service.js';
import { DashboardService } from './dashboard/dashboard.service.js';
import { ClubOpsService } from './members/club-ops.service.js';
import {
  BookingsAdminController,
  ClubMembersController,
  FederationPlayersController,
  MembersController,
  MembershipPlansController,
  PaymentsController,
} from './members/members.controller.js';
import { MembersService } from './members/members.service.js';
import { PaymentsService } from './members/payments.service.js';
import { ClubsAdminService } from './organizations/clubs-admin.service.js';
import {
  ClubsAdminController,
  CourtsAdminController,
  FederationsController,
  OrganizationsController,
} from './organizations/organizations.controller.js';
import { OrganizationsService } from './organizations/organizations.service.js';
import { DrawService } from './tournaments/draw.service.js';
import { AdminMatchesController, TournamentScheduleController } from './tournaments/matches.controller.js';
import { MatchesService } from './tournaments/matches.service.js';
import { EventsService } from './tournaments/events.service.js';
import { RegistrationsService } from './tournaments/registrations.service.js';
import { SportProfilesService } from './tournaments/sport-profiles.service.js';
import {
  AdminDrawController,
  AdminEventsController,
  AdminRegistrationsController,
  AdminTournamentsController,
  SportProfilesController,
} from './tournaments/tournaments.controller.js';
import { TournamentsService } from './tournaments/tournaments.service.js';
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
    OrganizationsController,
    FederationsController,
    ClubsAdminController,
    CourtsAdminController,
    ClubMembersController,
    MembersController,
    MembershipPlansController,
    PaymentsController,
    BookingsAdminController,
    FederationPlayersController,
    AdminTournamentsController,
    AdminEventsController,
    AdminRegistrationsController,
    SportProfilesController,
    AdminDrawController,
    AdminMatchesController,
    TournamentScheduleController,
    AnnouncementsController,
    ReportsController,
  ],
  providers: [
    AdminUsersService,
    RoleGrantsService,
    RolesService,
    AccessRequestsService,
    DashboardService,
    AuditLogsService,
    OrganizationsService,
    ClubsAdminService,
    MembersService,
    PaymentsService,
    ClubOpsService,
    TournamentsService,
    EventsService,
    RegistrationsService,
    SportProfilesService,
    DrawService,
    MatchesService,
    AnnouncementsService,
    ReportsService,
    RankingsService,
  ],
  exports: [AccessRequestsService, RoleGrantsService],
})
export class AdminModule {}
