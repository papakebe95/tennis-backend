import { Injectable } from '@nestjs/common';
import { AccessRequestStatus, BookingStatus, OrganizationType, UserStatus } from '@prisma/client';
import { publicStatus } from '../tournaments/tournament-lifecycle.js';
import { PrismaService } from '../../prisma/prisma.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKS = 12;

/** Monday 00:00 UTC of the week containing `date` (matches date_trunc('week')). */
export function weekStart(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(d.getTime() - day * DAY_MS);
}

/** `weeks` consecutive weeks ending with the current one, zero-filled. */
export function weeklySeries(rows: { week: Date; count: number }[], now: Date, weeks = WEEKS) {
  const byWeek = new Map(rows.map((r) => [weekStart(new Date(r.week)).getTime(), Number(r.count)]));
  const last = weekStart(now).getTime();
  return Array.from({ length: weeks }, (_, i) => {
    const week = last - (weeks - 1 - i) * 7 * DAY_MS;
    return { week: new Date(week).toISOString().slice(0, 10), count: byWeek.get(week) ?? 0 };
  });
}

/**
 * Platform-wide figures for the Super Admin dashboard. Only what the platform
 * records today; payment and tournament-operations figures join as those
 * modules land.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async global() {
    const now = new Date();
    const since = new Date(weekStart(now).getTime() - (WEEKS - 1) * 7 * DAY_MS);

    const [
      usersByStatus,
      activeLast30Days,
      organizations,
      competitions,
      bookingsUpcoming,
      bookingsToday,
      requestsByStatus,
      newUsers,
      bookingsMade,
      recentActivity,
    ] = await Promise.all([
      this.prisma.user.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.user.count({ where: { lastLoginAt: { gte: new Date(now.getTime() - 30 * DAY_MS) } } }),
      this.prisma.organization.groupBy({ by: ['type'], where: { status: 'ACTIVE' }, _count: { _all: true } }),
      this.prisma.competition.findMany({ select: { status: true } }),
      this.prisma.booking.count({
        where: { status: { not: BookingStatus.CANCELLED }, startTime: { gte: now, lt: new Date(now.getTime() + 7 * DAY_MS) } },
      }),
      this.prisma.booking.count({
        where: {
          status: { not: BookingStatus.CANCELLED },
          startTime: { gte: startOfUtcDay(now), lt: new Date(startOfUtcDay(now).getTime() + DAY_MS) },
        },
      }),
      this.prisma.accessRequest.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.$queryRaw<{ week: Date; count: number }[]>`
        SELECT date_trunc('week', "createdAt") AS week, count(*)::int AS count
        FROM "User" WHERE "createdAt" >= ${since} GROUP BY 1`,
      this.prisma.$queryRaw<{ week: Date; count: number }[]>`
        SELECT date_trunc('week', "createdAt") AS week, count(*)::int AS count
        FROM "Booking" WHERE "createdAt" >= ${since} GROUP BY 1`,
      this.prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          createdAt: true,
          actor: { select: { id: true, firstname: true, lastname: true } },
        },
      }),
    ]);

    const userCount = (status: UserStatus) => usersByStatus.find((u) => u.status === status)?._count._all ?? 0;
    const orgCount = (type: OrganizationType) => organizations.find((o) => o.type === type)?._count._all ?? 0;
    const requestCount = (status: AccessRequestStatus) =>
      requestsByStatus.find((r) => r.status === status)?._count._all ?? 0;
    const tournaments = { UPCOMING: 0, ONGOING: 0, COMPLETED: 0 };
    for (const competition of competitions) tournaments[publicStatus(competition.status) ?? 'UPCOMING']++;

    return {
      generatedAt: now.toISOString(),
      pendingActions: [
        { key: 'accessRequests', count: requestCount(AccessRequestStatus.PENDING), route: '/access-requests' },
        { key: 'accessRequestsAwaitingApplicant', count: requestCount(AccessRequestStatus.INFO_REQUESTED), route: '/access-requests' },
        { key: 'suspendedUsers', count: userCount(UserStatus.SUSPENDED), route: '/users' },
      ],
      users: {
        total: usersByStatus.reduce((sum, u) => sum + u._count._all, 0),
        active: userCount(UserStatus.ACTIVE),
        pending: userCount(UserStatus.PENDING),
        suspended: userCount(UserStatus.SUSPENDED),
        activeLast30Days,
      },
      organizations: {
        federations: orgCount(OrganizationType.FEDERATION),
        clubs: orgCount(OrganizationType.CLUB),
        communities: orgCount(OrganizationType.COMMUNITY),
      },
      tournaments: { total: competitions.length, ...tournaments },
      bookings: { today: bookingsToday, next7Days: bookingsUpcoming },
      series: {
        newUsers: weeklySeries(newUsers, now),
        bookingsMade: weeklySeries(bookingsMade, now),
      },
      recentActivity,
    };
  }
}

const startOfUtcDay = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
