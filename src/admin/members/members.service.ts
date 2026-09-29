import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { MemberStatus, PaymentPurpose, PaymentStatus, Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service.js';
import { orderBy, pageArgs, searchText, toPage } from '../../common/pagination.js';
import { csvDocument } from '../../common/csv.js';
import { t } from '../../i18n/i18n.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  addMonths,
  nextMembershipNumber,
  paymentStatus,
  paymentStatusWhere,
  remainingDue,
  renewalStart,
  startOfUtcDay,
} from './membership-rules.js';
import type {
  CreateMemberDto,
  CreatePlanDto,
  InitialPaymentDto,
  ListMembersQueryDto,
  MemberStatusDto,
  PlanDto,
  RenewMemberDto,
  UpdateMemberDto,
} from './members.dto.js';
import { paymentSelect, PaymentsService } from './payments.service.js';

type Tx = Prisma.TransactionClient;

const periodSelect = {
  id: true,
  startsAt: true,
  expiresAt: true,
  priceDue: true,
  currency: true,
  amountPaid: true,
  fullyPaid: true,
  plan: { select: { id: true, name: true } },
} satisfies Prisma.MembershipSelect;

const memberSelect = {
  id: true,
  membershipNumber: true,
  status: true,
  statusReason: true,
  notes: true,
  joinedAt: true,
  user: {
    select: {
      id: true,
      firstname: true,
      lastname: true,
      email: true,
      msisdn: true,
      playerProfile: { select: { level: true, ntrpRating: true, avatarUrl: true } },
    },
  },
  currentMembership: { select: periodSelect },
} satisfies Prisma.ClubMemberSelect;

type MemberRow = Prisma.ClubMemberGetPayload<{ select: typeof memberSelect }>;

const withPaymentStatus = <T extends { currentMembership: MemberRow['currentMembership'] }>(row: T, now: Date) => ({
  ...row,
  paymentStatus: row.currentMembership ? paymentStatus(row.currentMembership, now) : null,
  remainingDue: row.currentMembership ? remainingDue(row.currentMembership.priceDue, row.currentMembership.amountPaid) : 0,
});

/** "07 12 34 56 78" → "•• •• •• 56 78": enough to recognise, not to harvest. */
const maskPhone = (msisdn: string) => `${'•'.repeat(Math.max(0, msisdn.length - 4))}${msisdn.slice(-4)}`;

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly payments: PaymentsService,
  ) {}

  // ---------------------------------------------------------------- plans

  plans(clubId: string) {
    return this.prisma.membershipPlan.findMany({
      where: { clubId },
      orderBy: [{ active: 'desc' }, { price: 'desc' }],
      include: { _count: { select: { memberships: true } } },
    });
  }

  async createPlan(actorId: string, clubId: string, dto: CreatePlanDto) {
    const club = await this.club(clubId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const plan = await tx.membershipPlan.create({
          data: {
            clubId,
            name: dto.name,
            description: dto.description,
            durationMonths: dto.durationMonths,
            price: dto.price,
            active: dto.active ?? true,
          },
        });
        await this.audit.record(
          { actorId, action: 'membership.plan.created', entityType: 'MembershipPlan', entityId: plan.id, organizationId: club.organizationId, after: plan },
          tx,
        );
        return plan;
      });
    } catch (error) {
      throw this.uniqueError(error, 'errors.members.planNameTaken');
    }
  }

  async updatePlan(actorId: string, planId: string, dto: PlanDto) {
    const plan = await this.prisma.membershipPlan.findUnique({ where: { id: planId }, include: { club: true } });
    if (!plan) throw new NotFoundException(t('errors.members.planNotFound'));
    const data = {
      name: dto.name,
      description: dto.description,
      durationMonths: dto.durationMonths,
      price: dto.price,
      active: dto.active,
    };
    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.membershipPlan.update({ where: { id: planId }, data });
        await this.audit.record(
          {
            actorId,
            action: 'membership.plan.updated',
            entityType: 'MembershipPlan',
            entityId: planId,
            organizationId: plan.club.organizationId,
            before: plan,
            after: updated,
          },
          tx,
        );
        return updated;
      });
    } catch (error) {
      throw this.uniqueError(error, 'errors.members.planNameTaken');
    }
  }

  // -------------------------------------------------------------- members

  /**
   * People a club can add: an exact phone match, or a name match among the
   * platform's players. Phones come back masked.
   */
  async candidates(clubId: string, q: string) {
    const digits = q.replace(/\D/g, '');
    const rows = await this.prisma.user.findMany({
      where: {
        OR: [
          ...(digits.length >= 8 ? [{ msisdn: { endsWith: digits.slice(-9) } }] : []),
          {
            AND: q
              .split(/\s+/)
              .filter(Boolean)
              .map((part) => ({
                OR: [
                  { firstname: { contains: part, mode: 'insensitive' as const } },
                  { lastname: { contains: part, mode: 'insensitive' as const } },
                ],
              })),
          },
        ],
      },
      take: 10,
      orderBy: { lastname: 'asc' },
      select: {
        id: true,
        firstname: true,
        lastname: true,
        msisdn: true,
        playerProfile: { select: { level: true, avatarUrl: true } },
        clubMemberships: { where: { clubId }, select: { id: true } },
      },
    });
    return rows.map(({ msisdn, clubMemberships, ...user }) => ({
      ...user,
      phone: maskPhone(msisdn),
      alreadyMember: clubMemberships.length > 0,
    }));
  }

  async list(clubId: string, query: ListMembersQueryDto, all = false) {
    const now = new Date();
    const q = searchText(query.q);
    const where: Prisma.ClubMemberWhereInput = {
      clubId,
      status: query.status,
      ...(query.paymentStatus || query.planId
        ? {
            currentMembership: {
              is: {
                ...(query.paymentStatus ? paymentStatusWhere(query.paymentStatus, now) : {}),
                ...(query.planId ? { planId: query.planId } : {}),
              },
            },
          }
        : {}),
      ...(q
        ? {
            OR: [
              { membershipNumber: { contains: q, mode: 'insensitive' } },
              { user: { firstname: { contains: q, mode: 'insensitive' } } },
              { user: { lastname: { contains: q, mode: 'insensitive' } } },
              { user: { email: { contains: q, mode: 'insensitive' } } },
              ...(q.replace(/\D/g, '').length >= 3 ? [{ user: { msisdn: { contains: q.replace(/\D/g, '') } } }] : []),
            ],
          }
        : {}),
    };
    const sort = orderBy(query.sort, ['membershipNumber', 'joinedAt', 'status'], { field: 'joinedAt', direction: 'desc' });
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.clubMember.count({ where }),
      this.prisma.clubMember.findMany({
        where,
        ...(all ? { skip: 0, take: 5000 } : pageArgs(query)),
        orderBy: query.sort?.startsWith('expiresAt')
          ? { currentMembership: { expiresAt: query.sort.endsWith('asc') ? 'asc' : 'desc' } }
          : query.sort?.startsWith('lastname')
            ? { user: { lastname: query.sort.endsWith('asc') ? 'asc' : 'desc' } }
            : sort,
        select: memberSelect,
      }),
    ]);
    return toPage(
      rows.map((row) => withPaymentStatus(row, now)),
      total,
      query,
    );
  }

  /** The member list as CSV (same filters), for spreadsheets. */
  async listCsv(clubId: string, query: ListMembersQueryDto) {
    const page = await this.list(clubId, query, true);
    const header = ['number', 'firstname', 'lastname', 'phone', 'email', 'status', 'plan', 'starts', 'expires', 'price_due', 'amount_paid', 'payment_status', 'level'];
    return csvDocument(
      header,
      page.items.map((m) => [
        m.membershipNumber,
        m.user.firstname,
        m.user.lastname,
        m.user.msisdn,
        m.user.email,
        m.status,
        m.currentMembership?.plan?.name,
        m.currentMembership?.startsAt.toISOString().slice(0, 10),
        m.currentMembership?.expiresAt.toISOString().slice(0, 10),
        m.currentMembership?.priceDue,
        m.currentMembership?.amountPaid,
        m.paymentStatus,
        m.user.playerProfile?.level,
      ]),
    );
  }

  async detail(memberId: string) {
    const now = new Date();
    const member = await this.prisma.clubMember.findUnique({
      where: { id: memberId },
      select: {
        ...memberSelect,
        clubId: true,
        periods: {
          orderBy: { startsAt: 'desc' },
          select: {
            ...periodSelect,
            payments: { orderBy: { createdAt: 'desc' }, select: paymentSelect },
          },
        },
      },
    });
    if (!member) throw new NotFoundException(t('errors.members.notFound'));
    const [bookings, matches] = await Promise.all([
      this.prisma.booking.findMany({
        where: { userId: member.user.id, court: { clubId: member.clubId } },
        orderBy: { startTime: 'desc' },
        take: 20,
        select: {
          id: true,
          startTime: true,
          endTime: true,
          status: true,
          price: true,
          court: { select: { name: true } },
          payments: { where: { status: PaymentStatus.PAID }, select: { amount: true } },
        },
      }),
      this.prisma.match.findMany({
        where: {
          OR: [{ player1Id: member.user.id }, { player2Id: member.user.id }],
        },
        orderBy: { playedAt: 'desc' },
        take: 10,
        select: {
          id: true,
          playedAt: true,
          matchType: true,
          status: true,
          winnerId: true,
          player2Name: true,
          club: { select: { name: true } },
          player1: { select: { id: true, firstname: true, lastname: true } },
          player2: { select: { id: true, firstname: true, lastname: true } },
          sets: { orderBy: { setNumber: 'asc' }, select: { player1Games: true, player2Games: true } },
        },
      }),
    ]);
    return {
      ...withPaymentStatus(member, now),
      periods: member.periods.map((p) => ({
        ...p,
        paymentStatus: paymentStatus(p, now),
        remainingDue: remainingDue(p.priceDue, p.amountPaid),
      })),
      bookings: bookings.map(({ payments, ...b }) => ({
        ...b,
        paid: payments.reduce((sum, p) => sum + Number(p.amount), 0),
      })),
      matches,
    };
  }

  /** Adds a member with a first period (and optionally a first payment). */
  async create(actorId: string, clubId: string, dto: CreateMemberDto) {
    const club = await this.club(clubId);
    const [user, plan] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: dto.userId }, select: { id: true } }),
      this.activePlan(clubId, dto.planId),
    ]);
    if (!user) throw new NotFoundException(t('errors.members.userNotFound'));

    try {
      const memberId = await this.prisma.$transaction(async (tx) => {
        if (await tx.clubMember.findUnique({ where: { clubId_userId: { clubId, userId: dto.userId } } })) {
          throw new ConflictException(t('errors.members.alreadyMember'));
        }
        const number =
          dto.membershipNumber ??
          nextMembershipNumber(
            (await tx.clubMember.findMany({ where: { clubId }, select: { membershipNumber: true } })).map((m) => m.membershipNumber),
          );
        const startsAt = startOfUtcDay(dto.startsAt ?? new Date());
        const member = await tx.clubMember.create({
          data: { clubId, userId: dto.userId, membershipNumber: number, notes: dto.notes, joinedAt: startsAt },
        });
        const period = await this.openPeriod(tx, member.id, plan, startsAt);
        await this.audit.record(
          {
            actorId,
            action: 'member.created',
            entityType: 'ClubMember',
            entityId: member.id,
            organizationId: club.organizationId,
            after: { userId: dto.userId, membershipNumber: number, plan: plan.name, startsAt, expiresAt: period.expiresAt, priceDue: plan.price },
          },
          tx,
        );
        if (dto.payment) await this.firstPayment(tx, actorId, club.organizationId, period.id, dto.payment);
        return member.id;
      });
      return this.detail(memberId);
    } catch (error) {
      throw this.uniqueError(error, 'errors.members.numberTaken');
    }
  }

  async update(actorId: string, memberId: string, dto: UpdateMemberDto) {
    const member = await this.member(memberId);
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.clubMember.update({
          where: { id: memberId },
          data: { membershipNumber: dto.membershipNumber, notes: dto.notes },
        });
        await this.audit.record(
          {
            actorId,
            action: 'member.updated',
            entityType: 'ClubMember',
            entityId: memberId,
            organizationId: member.club.organizationId,
            before: { membershipNumber: member.membershipNumber, notes: member.notes },
            after: dto,
          },
          tx,
        );
      });
    } catch (error) {
      throw this.uniqueError(error, 'errors.members.numberTaken');
    }
    return this.detail(memberId);
  }

  async setStatus(actorId: string, memberId: string, dto: MemberStatusDto) {
    const member = await this.member(memberId);
    if (member.status === dto.status) throw new ConflictException(t('errors.members.noChange'));
    await this.prisma.$transaction(async (tx) => {
      await tx.clubMember.update({ where: { id: memberId }, data: { status: dto.status, statusReason: dto.reason ?? null } });
      await this.audit.record(
        {
          actorId,
          action: 'member.status.changed',
          entityType: 'ClubMember',
          entityId: memberId,
          organizationId: member.club.organizationId,
          before: { status: member.status },
          after: { status: dto.status },
          reason: dto.reason,
        },
        tx,
      );
    });
    return this.detail(memberId);
  }

  /** A new period, starting when the current one ends (or today). */
  async renew(actorId: string, memberId: string, dto: RenewMemberDto) {
    const member = await this.member(memberId);
    if (member.status === MemberStatus.LEFT) throw new ConflictException(t('errors.members.left'));
    const plan = await this.activePlan(member.clubId, dto.planId);
    await this.prisma.$transaction(async (tx) => {
      const startsAt = renewalStart(member.currentMembership?.expiresAt ?? null);
      const period = await this.openPeriod(tx, memberId, plan, startsAt);
      if (member.status === MemberStatus.SUSPENDED) {
        // Renewing is an explicit decision to keep the member.
        await tx.clubMember.update({ where: { id: memberId }, data: { status: MemberStatus.ACTIVE, statusReason: null } });
      }
      await this.audit.record(
        {
          actorId,
          action: 'member.renewed',
          entityType: 'ClubMember',
          entityId: memberId,
          organizationId: member.club.organizationId,
          after: { plan: plan.name, startsAt, expiresAt: period.expiresAt, priceDue: plan.price },
        },
        tx,
      );
      if (dto.payment) await this.firstPayment(tx, actorId, member.club.organizationId, period.id, dto.payment);
    });
    return this.detail(memberId);
  }

  // ------------------------------------------------------------- helpers

  private async openPeriod(tx: Tx, memberId: string, plan: { id: string; durationMonths: number; price: Prisma.Decimal; currency: string }, startsAt: Date) {
    const period = await tx.membership.create({
      data: {
        memberId,
        planId: plan.id,
        startsAt,
        expiresAt: addMonths(startsAt, plan.durationMonths),
        priceDue: plan.price,
        currency: plan.currency,
        fullyPaid: plan.price.lessThanOrEqualTo(0),
      },
    });
    await tx.clubMember.update({ where: { id: memberId }, data: { currentMembershipId: period.id } });
    return period;
  }

  private firstPayment(tx: Tx, actorId: string, organizationId: string, membershipId: string, payment: InitialPaymentDto) {
    if (payment.amount <= 0) return null;
    return this.payments.record(
      actorId,
      organizationId,
      { purpose: PaymentPurpose.MEMBERSHIP, membershipId, amount: payment.amount, methodKey: payment.methodKey, externalReference: payment.externalReference },
      tx,
    );
  }

  private async club(clubId: string) {
    const club = await this.prisma.club.findUnique({ where: { id: clubId }, select: { id: true, organizationId: true } });
    if (!club) throw new NotFoundException(t('errors.clubs.notFound'));
    return club;
  }

  private async member(memberId: string) {
    const member = await this.prisma.clubMember.findUnique({
      where: { id: memberId },
      include: { club: { select: { organizationId: true } }, currentMembership: { select: { expiresAt: true } } },
    });
    if (!member) throw new NotFoundException(t('errors.members.notFound'));
    return member;
  }

  private async activePlan(clubId: string, planId: string) {
    const plan = await this.prisma.membershipPlan.findFirst({ where: { id: planId, clubId } });
    if (!plan) throw new NotFoundException(t('errors.members.planNotFound'));
    if (!plan.active) throw new BadRequestException(t('errors.members.planInactive'));
    return plan;
  }

  private uniqueError(error: unknown, key: 'errors.members.planNameTaken' | 'errors.members.numberTaken') {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
      ? new ConflictException(t(key))
      : error;
  }
}
