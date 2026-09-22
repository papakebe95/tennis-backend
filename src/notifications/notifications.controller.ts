import {
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../auth/jwt.strategy.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { NotificationsService } from './notifications.service.js';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  list(@CurrentUser() currentUser: AuthenticatedUser) {
    return this.notificationsService.list(currentUser.userId);
  }

  // Literal routes are declared before ':id' so they aren't read as ids.
  @Get('unread-count')
  async unreadCount(@CurrentUser() currentUser: AuthenticatedUser) {
    return {
      count: await this.notificationsService.unreadCount(currentUser.userId),
    };
  }

  @Post('read-all')
  @HttpCode(200)
  markAllRead(@CurrentUser() currentUser: AuthenticatedUser) {
    return this.notificationsService.markAllRead(currentUser.userId);
  }

  @Patch(':id/read')
  markRead(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.notificationsService.markRead(currentUser.userId, id);
  }
}
