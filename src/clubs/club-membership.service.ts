import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { MemberStatus, MembershipRequestStatus, OrganizationStatus, Prisma } from '@prisma/client';
import { paymentStatus } from '../admin/members/membership-rules.js';
import { AuditService } from '../audit/audit.service.js';
import { t } from '../i18n/i18n.js';
import { membershipRequested } from '../notifications/notification-messages.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** A member counts as belonging to the club unless they left. */
const IN_CLUB: MemberStatus[] = [MemberStatus.ACTIVE, MemberStatus.SUSPENDED];

const memberSelect = {
  id: true,
  membershipNumber: true,
  status: true,
  joinedAt: true,
  club: { select: { id: true, name: true, logoUrl: true, city: { select: { name: true } } } },
  currentMembership: {
    select: {
      startsAt: true,
      expiresAt: true,
      priceDue: true,
      amountPaid: true,
      fullyPaid: true,
      currency: true,
      plan: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.ClubMemberSelect;

const requestSelect = {
  id: true,
  status: true,
  message: true,
  reason: true,
  createdAt: true,
  decidedAt: true,
  plan: { select: { id: true, name: true } },
  club: { select: { id: true, name: true, logoUrl: true } },
} satisfies Prisma.ClubMembershipRequestSelect;

type MemberRow = Prisma.ClubMemberGetPayload<{ select: typeof memberSelect }>;

const memberView = (m: MemberRow, now = new Date()) => {
  const period = m.currentMembership;
  return {
    id: m.id,
    membershipNumber: m.membershipNumber,
    status: m.status,
    joinedAt: m.joinedAt,
    club: { id: m.club.id, name: m.club.name, logoUrl: m.club.logoUrl, city: m.club.city.name },
    currentPeriod: period && {
      plan: period.plan,
      startsAt: period.startsAt,
      expiresAt: period.expiresAt,
      priceDue: period.priceDue,
      amountPaid: period.amountPaid,
      currency: period.currency,
      // PAID, PARTIALLY_PAID, PENDING, OVERDUE or EXPIRED: as the club sees it.
      paymentStatus: paymentStatus(period, now),
    },
  };
};

/**
 * Club membership from the player's side: see where they stand with a club,
 * ask to join (the club approves in the back-office), cancel that request,
 * or leave. Membership itself (number, plan, dues) is always set by the
 * club.
 */
@Injectable()
export class ClubMembershipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** The player's clubs (current memberships) and pending requests. */
  async myClubs(userId: string) {
    const [members, requests] = await Promise.all([
      this.prisma.clubMember.findMany({
        where: { userId, status: { in: IN_CLUB } },
        orderBy: { joinedAt: 'asc' },
        select: memberSelect,
      }),
      this.prisma.clubMembershipRequest.findMany({
        where: { userId, status: MembershipRequestStatus.PENDING },
        orderBy: { createdAt: 'desc' },
        select: requestSelect,
      }),
    ]);
    const now = new Date();
    return { memberships: members.map((m) => memberView(m, now)), pendingRequests: requests };
  }

  /** Where the player stands with one club, and the plans they can ask for. */
  async status(userId: string, clubId: string) {
    const club = await this.club(clubId);
    const [member, request, plans] = await Promise.all([
      this.prisma.clubMember.findUnique({ where: { clubId_userId: { clubId, userId } }, select: memberSelect }),
      this.prisma.clubMembershipRequest.findFirst({ where: { clubId, userId }, orderBy: { createdAt: 'desc' }, select: requestSelect }),
      this.prisma.membershipPlan.findMany({
        where: { clubId, active: true },
        orderBy: [{ price: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, description: true, durationMonths: true, price: true, currency: true },
      }),
    ]);
    const isMember = !!member && IN_CLUB.includes(member.status);
    const pending = request?.status === MembershipRequestStatus.PENDING;
    return {
      club: { id: club.id, name: club.name },
      member: isMember ? memberView(member) : null,
      request,
      plans,
      canRequest: !isMember && !pending,
      canLeave: isMember,
    };
  }

  /**
   * Asks to join. Idempotent while a request is pending (a retry returns
   * the same request); refused for current members.
   */
  async request(userId: string, clubId: string, input: { planId?: string; message?: string }) {
    const club = await this.club(clubId);
    if (input.planId) {
      const plan = await this.prisma.membershipPlan.findFirst({ where: { id: input.planId, clubId, active: true } });
      if (!plan) throw new NotFoundException(t('errors.members.planNotFound'));
    }
    const member = await this.prisma.clubMember.findUnique({ where: { clubId_userId: { clubId, userId } }, select: { status: true } });
    if (member && IN_CLUB.includes(member.status)) throw new ConflictException({ message: t('errors.clubMembership.alreadyMember'), code: 'ALREADY_MEMBER' });

    const pending = await this.prisma.clubMembershipRequest.findFirst({ where: { clubId, userId, status: MembershipRequestStatus.PENDING } });
    if (!pending) {
      await this.prisma.$transaction(async (tx) => {
        const row = await tx.clubMembershipRequest.create({ data: { clubId, userId, planId: input.planId ?? null, message: input.message ?? null } });
        await this.audit.record(
          { actorId: userId, action: 'membership.requested', entityType: 'ClubMembershipRequest', entityId: row.id, organizationId: club.organizationId, after: { planId: row.planId, message: row.message } },
          tx,
        );
        return row;
      });
      await this.notifyStaff(club, userId);
    }
    return this.status(userId, clubId);
  }

  async cancel(userId: string, clubId: string) {
    const club = await this.club(clubId);
    const pending = await this.prisma.clubMembershipRequest.findFirst({ where: { clubId, userId, status: MembershipRequestStatus.PENDING } });
    if (!pending) throw new NotFoundException(t('errors.clubMembership.noPendingRequest'));
    await this.prisma.$transaction(async (tx) => {
      await tx.clubMembershipRequest.update({ where: { id: pending.id }, data: { status: MembershipRequestStatus.CANCELLED, decidedAt: new Date(), decidedById: userId } });
      await this.audit.record(
        { actorId: userId, action: 'membership.request.cancelled', entityType: 'ClubMembershipRequest', entityId: pending.id, organizationId: club.organizationId },
        tx,
      );
    });
    return this.status(userId, clubId);
  }

  /** Leaves the club: the membership record and its history stay, marked LEFT. */
  async leave(userId: string, clubId: string, reason?: string) {
    const club = await this.club(clubId);
    const member = await this.prisma.clubMember.findUnique({ where: { clubId_userId: { clubId, userId } } });
    if (!member || !IN_CLUB.includes(member.status)) throw new NotFoundException(t('errors.clubMembership.notMember'));
    await this.prisma.$transaction(async (tx) => {
      await tx.clubMember.update({
        where: { id: member.id },
        data: { status: MemberStatus.LEFT, statusReason: reason?.trim() || t('clubMembership.leftFromApp') },
      });
      await this.audit.record(
        {
          actorId: userId,
          action: 'member.status.changed',
          entityType: 'ClubMember',
          entityId: member.id,
          organizationId: club.organizationId,
          before: { status: member.status },
          after: { status: MemberStatus.LEFT, byPlayer: true },
          reason,
        },
        tx,
      );
    });
    return this.status(userId, clubId);
  }

  private async club(clubId: string) {
    const club = await this.prisma.club.findUnique({
      where: { id: clubId },
      select: { id: true, name: true, organizationId: true, organization: { select: { status: true } } },
    });
    if (!club || club.organization.status !== OrganizationStatus.ACTIVE) throw new NotFoundException(t('errors.clubs.notFound'));
    return club;
  }

  /** Club staff who manage members hear about the request. */
  private async notifyStaff(club: { name: string; organizationId: string }, userId: string) {
    const [player, staff] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { firstname: true, lastname: true } }),
      this.prisma.userRole.findMany({
        where: {
          organizationId: club.organizationId,
          revokedAt: null,
          user: { status: 'ACTIVE' },
          role: { permissions: { some: { permissionKey: 'member.manage' } } },
        },
        select: { userId: true },
        distinct: ['userId'],
      }),
    ]);
    const message = membershipRequested(`${player.firstname} ${player.lastname}`, club.name);
    for (const s of staff) await this.notifications.notify(s.userId, message);
  }
}
