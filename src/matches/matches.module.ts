import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { MatchesController } from './matches.controller.js';
import { MatchesService } from './matches.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    NotificationsModule,
  ],
  controllers: [MatchesController],
  providers: [MatchesService],
})
export class MatchesModule {}
