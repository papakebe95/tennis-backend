import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

export interface NotifyInput {
  type: NotificationType;
  title: string;
  body: string;
  /** In-app path opened when the notification is tapped ("/club/bookings"). */
  route?: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records a notification for a player. Best-effort by design: a failure to
   * notify is logged and swallowed so it can never fail the booking, match or
   * purchase that triggered it.
   */
  async notify(userId: string, input: NotifyInput): Promise<void> {
    try {
      await this.prisma.notification.create({
        data: {
          userId,
          type: input.type,
          title: input.title,
          body: input.body,
          data: input.route ? { route: input.route } : undefined,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Could not notify user ${userId} (${input.type}): ${String(error)}`,
      );
    }
  }

  async list(userId: string) {
    const [items, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          type: true,
          title: true,
          body: true,
          data: true,
          read: true,
          createdAt: true,
        },
      }),
      this.unreadCount(userId),
    ]);
    return { unreadCount, items };
  }

  async unreadCount(userId: string) {
    return this.prisma.notification.count({ where: { userId, read: false } });
  }

  async markRead(userId: string, id: string) {
    // Scoped by userId so nobody can touch another player's notifications.
    const { count } = await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { read: true },
    });
    if (count === 0) throw new NotFoundException('Notification not found');
    return { unreadCount: await this.unreadCount(userId) };
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });
    return { unreadCount: 0 };
  }
}
