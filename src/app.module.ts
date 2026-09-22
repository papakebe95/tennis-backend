import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { ClubsModule } from './clubs/clubs.module.js';
import { CourtsModule } from './courts/courts.module.js';
import { BookingsModule } from './bookings/bookings.module.js';
import { UploadsModule } from './uploads/uploads.module.js';
import { MarketplaceModule } from './marketplace/marketplace.module.js';
import { MatchesModule } from './matches/matches.module.js';
import { CompetitionsModule } from './competitions/competitions.module.js';
import { StoriesModule } from './stories/stories.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    UsersModule,
    ClubsModule,
    CourtsModule,
    BookingsModule,
    UploadsModule,
    MarketplaceModule,
    MatchesModule,
    CompetitionsModule,
    StoriesModule,
    NotificationsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
