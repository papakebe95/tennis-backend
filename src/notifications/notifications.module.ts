import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  // Other feature modules raise notifications through this service.
  exports: [NotificationsService],
})
export class NotificationsModule {}
