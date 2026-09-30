import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { MemberStatus, MembershipRequestStatus, Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service.js';
import { t } from '../../i18n/i18n.js';
import { membershipDecided } from '../../notifications/notification-messages.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { ApproveMembershipRequestDto } from './members.dto.js';
import { MembersService } from './members.service.js';

const listSelect = {
  id: true,
  status: true,
  message: true,
  reason: true,
  createdAt: true,
  decidedAt: true,
  memberId: true,
  plan: { select: { id: true, name: true } },
  decidedBy: { select: { id: true, firstname: true, lastname: true } },
  user: {
    select: {
      id: true,
      firstname: true,
      lastname: true,
      msisdn: true,
      email: true,
      playerProfile: { select: { avatarUrl: true, level: true, classification: { select: { code: true } } } },
    },
  },
} satisfies Prisma.ClubMembershipRequestSelect;

/**
 * Players' requests to join a club, answered by club staff. Approving goes
 * through the usual membership rules: a new member gets a number and a
 * first period on the chosen plan; a former member who left is reactivated
 * with a new period, keeping their number and history.
 */
@Injectable()
export class MembershipRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly members: MembersService,
  ) {}

  async list(clubId: string, status?: MembershipRequestStatus) {
    const [items, pending] = await Promise.all([
      this.prisma.clubMembershipRequest.findMany({
        where: { clubId, ...(status ? { status } : {}) },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        take: 200,
        select: listSelect,
      }),
      this.prisma.clubMembershipRequest.count({ where: { clubId, status: MembershipRequestStatus.PENDING } }),
    ]);
    // Former members asking to come back are shown as such.
    const former = await this.prisma.clubMember.findMany({
      where: { clubId, userId: { in: items.map((r) => r.user.id) } },
      select: { userId: true, status: true, membershipNumber: true },
    });
    return {
      pending,
      items: items.map((r) => ({ ...r, previousMembership: former.find((m) => m.userId === r.user.id) ?? null })),
    };
  }

  async approve(actorId: string, id: string, dto: ApproveMembershipRequestDto) {
    const request = await this.pending(id);
    const existing = await this.prisma.clubMember.findUnique({ where: { clubId_userId: { clubId: request.clubId, userId: request.userId } } });

    let memberId: string;
    if (existing && existing.status !== MemberStatus.LEFT) {
      // Added by staff in the meantime: the request is simply answered.
      memberId = existing.id;
    } else if (existing) {
      await this.members.setStatus(actorId, existing.id, { status: MemberStatus.ACTIVE, reason: t('clubMembership.rejoined') });
      await this.members.renew(actorId, existing.id, { planId: dto.planId, payment: dto.payment });
      memberId = existing.id;
    } else {
      const member = await this.members.create(actorId, request.clubId, {
        userId: request.userId,
        planId: dto.planId,
        startsAt: dto.startsAt,
        membershipNumber: dto.membershipNumber,
        notes: dto.notes,
        payment: dto.payment,
      });
      memberId = member.id;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.clubMembershipRequest.update({
        where: { id },
        data: { status: MembershipRequestStatus.APPROVED, decidedAt: new Date(), decidedById: actorId, memberId },
      });
      await this.audit.record(
        { actorId, action: 'membership.request.approved', entityType: 'ClubMembershipRequest', entityId: id, organizationId: request.club.organizationId, after: { memberId, planId: dto.planId } },
        tx,
      );
    });
    await this.notifications.notify(request.userId, membershipDecided(true, request.club.name));
    return this.members.detail(memberId);
  }

  async decline(actorId: string, id: string, reason: string) {
    const request = await this.pending(id);
    await this.prisma.$transaction(async (tx) => {
      await tx.clubMembershipRequest.update({
        where: { id },
        data: { status: MembershipRequestStatus.DECLINED, decidedAt: new Date(), decidedById: actorId, reason },
      });
      await this.audit.record(
        { actorId, action: 'membership.request.declined', entityType: 'ClubMembershipRequest', entityId: id, organizationId: request.club.organizationId, reason },
        tx,
      );
    });
    await this.notifications.notify(request.userId, membershipDecided(false, request.club.name, reason));
  }

  private async pending(id: string) {
    const request = await this.prisma.clubMembershipRequest.findUnique({
      where: { id },
      include: { club: { select: { name: true, organizationId: true } } },
    });
    if (!request) throw new NotFoundException(t('errors.clubMembership.requestNotFound'));
    if (request.status !== MembershipRequestStatus.PENDING) {
      throw new ConflictException({ message: t('errors.clubMembership.notPending'), code: 'REQUEST_NOT_PENDING' });
    }
    return request;
  }
}
