import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ClubMembershipController } from './club-membership.controller.js';
import { ClubMembershipService } from './club-membership.service.js';
import { ClubsController } from './clubs.controller.js';
import { ClubsService } from './clubs.service.js';

@Module({
  imports: [NotificationsModule],
  controllers: [ClubsController, ClubMembershipController],
  providers: [ClubsService, ClubMembershipService],
  exports: [ClubsService],
})
export class ClubsModule {}
