import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { BookingsController } from './bookings.controller.js';
import { BookingsService } from './bookings.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    NotificationsModule,
  ],
  controllers: [BookingsController],
  providers: [BookingsService],
  exports: [BookingsService],
})
export class BookingsModule {}
