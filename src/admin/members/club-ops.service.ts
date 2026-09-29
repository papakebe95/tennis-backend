import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AffiliationStatus, BookingStatus, CourtStatus, MemberStatus, OrganizationType, PaymentStatus, Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service.js';
import { pageArgs, searchText, toPage } from '../../common/pagination.js';
import { publicStatus } from '../tournaments/tournament-lifecycle.js';
import { t } from '../../i18n/i18n.js';
import { bookingCancelled } from '../../notifications/notification-messages.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { weeklySeries } from '../dashboard/dashboard.service.js';
import { GRACE_DAYS, paymentStatusWhere } from './membership-rules.js';
import type { FederationPlayersQueryDto, ListBookingsQueryDto } from './members.dto.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_BOOKING: BookingStatus[] = [BookingStatus.PENDING, BookingStatus.CONFIRMED];

/** First day of the month `offset` months from `date` (UTC). */
export const monthStart = (date: Date, offset = 0) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1));

/** Club bookings, the club dashboard and federation players. */
@Injectable()
export class ClubOpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // ------------------------------------------------------------ bookings

  async bookings(clubId: string, query: ListBookingsQueryDto) {
    const q = searchText(query.q);
    const where: Prisma.BookingWhereInput = {
      court: { clubId },
      courtId: query.courtId,
      status: query.status,
      ...(query.from || query.to ? { startTime: { gte: query.from, lt: query.to } } : {}),
      ...(q
        ? {
            user: {
              OR: [
                { firstname: { contains: q, mode: 'insensitive' } },
                { lastname: { contains: q, mode: 'insensitive' } },
                { msisdn: { contains: q.replace(/\D/g, '') || q } },
              ],
            },
          }
        : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.booking.count({ where }),
      this.prisma.booking.findMany({
        where,
        ...pageArgs(query),
        orderBy: { startTime: query.sort === 'startTime:desc' ? 'desc' : 'asc' },
        select: {
          id: true,
          startTime: true,
          endTime: true,
          status: true,
          price: true,
          lookingForPartner: true,
          cancelledAt: true,
          cancelReason: true,
          createdAt: true,
          court: { select: { id: true, name: true, number: true } },
          user: { select: { id: true, firstname: true, lastname: true, msisdn: true } },
          payments: { where: { status: PaymentStatus.PAID }, select: { amount: true } },
        },
      }),
    ]);
    return toPage(
      rows.map(({ payments, ...b }) => {
        const paid = payments.reduce((sum, p) => sum + Number(p.amount), 0);
        return { ...b, paid, fullyPaid: b.price === null || paid >= Number(b.price) };
      }),
      total,
      query,
    );
  }

  /** The club cancels a booking (reason required); the player is notified. */
  async cancelBooking(actorId: string, bookingId: string, reason: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { court: { include: { club: true } } },
    });
    if (!booking) throw new NotFoundException(t('errors.bookings.notFound'));
    if (booking.status === BookingStatus.CANCELLED) throw new ConflictException(t('errors.bookings.alreadyCancelled'));
    await this.prisma.$transaction(async (tx) => {
      await tx.booking.update({
        where: { id: bookingId },
        data: { status: BookingStatus.CANCELLED, cancelledAt: new Date(), cancelReason: reason },
      });
      await this.audit.record(
        {
          actorId,
          action: 'booking.cancelled',
          entityType: 'Booking',
          entityId: bookingId,
          organizationId: booking.court.club.organizationId,
          before: { status: booking.status },
          after: { status: BookingStatus.CANCELLED },
          reason,
        },
        tx,
      );
    });
    await this.notifications.notify(
      booking.userId,
      bookingCancelled({ courtName: booking.court.name, clubName: booking.court.club.name, start: booking.startTime }),
    );
    return { id: bookingId, status: BookingStatus.CANCELLED };
  }

  // ------------------------------------------------------------ dashboard

  /** What a club administrator needs to act on, then the club's figures. */
  async dashboard(clubId: string) {
    const club = await this.prisma.club.findUnique({ where: { id: clubId }, select: { id: true, name: true, organizationId: true } });
    if (!club) throw new NotFoundException(t('errors.clubs.notFound'));
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const tomorrow = new Date(today.getTime() + DAY_MS);
    const in30 = new Date(now.getTime() + 30 * DAY_MS);
    const sixMonthsAgo = monthStart(now, -5);
    const current = { expiresAt: { gte: now } };

    const [
      members,
      activeMembers,
      expired,
      expiringSoon,
      overdue,
      unpaid,
      courts,
      bookingsToday,
      bookingsUpcoming,
      revenueMonth,
      revenueByMonth,
      newMembers,
      competitions,
      pendingRegistrations,
      recentActivity,
      todayList,
    ] = await Promise.all([
      this.prisma.clubMember.count({ where: { clubId, status: { not: MemberStatus.LEFT } } }),
      this.prisma.clubMember.count({ where: { clubId, status: MemberStatus.ACTIVE, currentMembership: { is: current } } }),
      this.prisma.clubMember.count({ where: { clubId, status: { not: MemberStatus.LEFT }, currentMembership: { is: { expiresAt: { lt: now } } } } }),
      this.prisma.clubMember.count({ where: { clubId, status: MemberStatus.ACTIVE, currentMembership: { is: { expiresAt: { gte: now, lt: in30 } } } } }),
      this.prisma.clubMember.count({ where: { clubId, status: { not: MemberStatus.LEFT }, currentMembership: { is: paymentStatusWhere('OVERDUE', now) } } }),
      this.prisma.membership.aggregate({
        where: { member: { clubId, status: { not: MemberStatus.LEFT } }, currentOf: { isNot: null }, fullyPaid: false, expiresAt: { gte: now } },
        _sum: { priceDue: true, amountPaid: true },
        _count: { _all: true },
      }),
      this.prisma.court.groupBy({ by: ['status'], where: { clubId, archivedAt: null }, _count: { _all: true }, orderBy: { status: 'asc' } }),
      this.prisma.booking.count({ where: { court: { clubId }, status: { in: ACTIVE_BOOKING }, startTime: { gte: today, lt: tomorrow } } }),
      this.prisma.booking.count({ where: { court: { clubId }, status: { in: ACTIVE_BOOKING }, startTime: { gte: now, lt: new Date(now.getTime() + 7 * DAY_MS) } } }),
      this.prisma.payment.aggregate({
        where: { organizationId: club.organizationId, status: PaymentStatus.PAID, paidAt: { gte: monthStart(now) } },
        _sum: { amount: true },
      }),
      this.prisma.$queryRaw<{ month: Date; amount: Prisma.Decimal }[]>`
        SELECT date_trunc('month', "paidAt") AS month, SUM("amount") AS amount
        FROM "Payment"
        WHERE "organizationId" = ${club.organizationId} AND "status" = 'PAID' AND "paidAt" >= ${sixMonthsAgo}
        GROUP BY 1`,
      this.prisma.$queryRaw<{ week: Date; count: number }[]>`
        SELECT date_trunc('week', "joinedAt") AS week, count(*)::int AS count
        FROM "ClubMember" WHERE "clubId" = ${clubId} AND "joinedAt" >= ${new Date(now.getTime() - 84 * DAY_MS)} GROUP BY 1`,
      this.prisma.competition.findMany({ where: { OR: [{ clubId }, { hostOrganization: { club: { id: clubId } } }] }, select: { id: true, name: true, status: true, startDate: true, endDate: true } }),
      // Entries waiting for a decision in tournaments the club hosts.
      this.prisma.competitionParticipant.count({
        where: {
          status: 'PENDING',
          competition: {
            hostOrganization: { club: { id: clubId } },
            status: { in: ['DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED'] },
          },
        },
      }),
      this.prisma.auditLog.findMany({
        where: { organizationId: club.organizationId },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, action: true, entityType: true, entityId: true, createdAt: true, actor: { select: { id: true, firstname: true, lastname: true } } },
      }),
      this.prisma.booking.findMany({
        where: { court: { clubId }, status: { in: ACTIVE_BOOKING }, startTime: { gte: now, lt: tomorrow } },
        orderBy: { startTime: 'asc' },
        take: 6,
        select: {
          id: true,
          startTime: true,
          endTime: true,
          court: { select: { name: true } },
          user: { select: { firstname: true, lastname: true } },
        },
      }),
    ]);

    const courtCount = (status: CourtStatus) => courts.find((c) => c.status === status)?._count._all ?? 0;
    const tournaments = competitions.map((c) => ({ ...c, status: publicStatus(c.status) ?? 'UPCOMING' }));
    const months = Array.from({ length: 6 }, (_, i) => monthStart(now, i - 5));
    const byMonth = new Map(revenueByMonth.map((r) => [monthStart(new Date(r.month)).getTime(), Number(r.amount)]));
    const outstanding = Number(unpaid._sum.priceDue ?? 0) - Number(unpaid._sum.amountPaid ?? 0);

    return {
      club: { id: club.id, name: club.name },
      pendingActions: [
        { key: 'overdueMemberships', count: overdue, route: 'members?paymentStatus=OVERDUE' },
        { key: 'expiringSoon', count: expiringSoon, route: 'members?sort=expiresAt:asc' },
        { key: 'expiredMemberships', count: expired, route: 'members?paymentStatus=EXPIRED' },
        { key: 'courtsUnavailable', count: courtCount(CourtStatus.MAINTENANCE) + courtCount(CourtStatus.DISABLED), route: 'courts' },
        { key: 'pendingRegistrations', count: pendingRegistrations, route: '/tournaments' },
      ],
      members: { total: members, active: activeMembers, expired, graceDays: GRACE_DAYS },
      payments: { unpaidCount: unpaid._count._all, outstanding, revenueThisMonth: Number(revenueMonth._sum.amount ?? 0), currency: 'XOF' },
      courts: { available: courtCount(CourtStatus.AVAILABLE), maintenance: courtCount(CourtStatus.MAINTENANCE), disabled: courtCount(CourtStatus.DISABLED) },
      bookings: { today: bookingsToday, next7Days: bookingsUpcoming, todayList },
      tournaments: {
        upcoming: tournaments.filter((c) => c.status === 'UPCOMING').length,
        ongoing: tournaments.filter((c) => c.status === 'ONGOING').length,
      },
      series: {
        revenueByMonth: months.map((m) => ({ month: m.toISOString().slice(0, 7), amount: byMonth.get(m.getTime()) ?? 0 })),
        newMembers: weeklySeries(newMembers, now),
      },
      recentActivity,
    };
  }

  // ------------------------------------------------------ federation players

  /**
   * Players with a current membership in one of the federation's active
   * affiliated clubs. (Federation licences, if introduced, would replace
   * this definition.)
   */
  async federationPlayers(federationId: string, query: FederationPlayersQueryDto) {
    const federation = await this.prisma.organization.findUnique({ where: { id: federationId }, select: { type: true } });
    if (!federation || federation.type !== OrganizationType.FEDERATION) {
      throw new NotFoundException(t('errors.organizations.wrongType', { type: OrganizationType.FEDERATION }));
    }
    const now = new Date();
    const q = searchText(query.q);
    const affiliatedClub: Prisma.ClubWhereInput = {
      organization: {
        status: 'ACTIVE',
        memberships: { some: { parentOrgId: federationId, status: AffiliationStatus.ACTIVE } },
      },
    };
    const memberWhere: Prisma.ClubMemberWhereInput = {
      status: MemberStatus.ACTIVE,
      club: query.clubId ? { AND: [affiliatedClub, { id: query.clubId }] } : affiliatedClub,
      currentMembership: { is: { expiresAt: { gte: now } } },
    };
    const where: Prisma.UserWhereInput = {
      clubMemberships: { some: memberWhere },
      ...(q
        ? {
            OR: [
              { firstname: { contains: q, mode: 'insensitive' } },
              { lastname: { contains: q, mode: 'insensitive' } },
              { msisdn: { contains: q.replace(/\D/g, '') || q } },
            ],
          }
        : {}),
    };
    const [total, rows, clubs] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        ...pageArgs(query),
        orderBy: [{ lastname: 'asc' }, { firstname: 'asc' }],
        select: {
          id: true,
          firstname: true,
          lastname: true,
          msisdn: true,
          status: true,
          createdAt: true,
          playerProfile: {
            select: {
              level: true,
              ntrpRating: true,
              avatarUrl: true,
              gender: true,
              birthDate: true,
              classification: { select: { id: true, code: true } },
            },
          },
          clubMemberships: {
            where: memberWhere,
            select: {
              membershipNumber: true,
              joinedAt: true,
              club: { select: { id: true, name: true } },
              currentMembership: { select: { expiresAt: true } },
            },
          },
        },
      }),
      this.prisma.club.findMany({ where: affiliatedClub, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    ]);
    return { ...toPage(rows, total, query), clubs };
  }
}
