import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PaymentPurpose, PaymentStatus, Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../../audit/audit.service.js';
import type { ScopeFilter } from '../../authz/scope.js';
import { pageArgs, searchText, toPage } from '../../common/pagination.js';
import { t } from '../../i18n/i18n.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { remainingDue } from './membership-rules.js';
import type { ListPaymentsQueryDto, RecordPaymentDto } from './members.dto.js';

type Tx = Prisma.TransactionClient;

export const paymentSelect = {
  id: true,
  reference: true,
  purpose: true,
  status: true,
  amount: true,
  currency: true,
  methodKey: true,
  externalReference: true,
  payerName: true,
  paidAt: true,
  notes: true,
  refundedAt: true,
  refundReason: true,
  createdAt: true,
  membershipId: true,
  bookingId: true,
  organization: { select: { id: true, name: true } },
  method: { select: { key: true, label: true } },
  payer: { select: { id: true, firstname: true, lastname: true, msisdn: true } },
  recordedBy: { select: { id: true, firstname: true, lastname: true } },
  booking: { select: { id: true, startTime: true, court: { select: { name: true } } } },
  participantId: true,
  participant: { select: { id: true, event: { select: { name: true } }, competition: { select: { id: true, name: true } } } },
} satisfies Prisma.PaymentSelect;

/** "PAY-20260928-7K3QX2": dated, unguessable, easy to read out. */
export const paymentReference = (at = new Date()) =>
  `PAY-${at.toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(4).toString('hex').slice(0, 6).toUpperCase()}`;

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  methods() {
    return this.prisma.paymentMethod.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } });
  }

  /** Payments visible in `scope`, with totals for the same filter. */
  async list(scope: ScopeFilter, query: ListPaymentsQueryDto) {
    const where = this.where(scope, query);
    const [total, items, sums] = await this.prisma.$transaction([
      this.prisma.payment.count({ where }),
      this.prisma.payment.findMany({
        where,
        ...(query.format === 'csv' ? { skip: 0, take: 5000 } : pageArgs(query)),
        orderBy: [{ paidAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
        select: paymentSelect,
      }),
      this.prisma.payment.groupBy({
        by: ['status', 'currency'],
        where,
        _sum: { amount: true },
        orderBy: { status: 'asc' },
      }),
    ]);
    return {
      ...toPage(items, total, query),
      totals: sums.map((s) => ({ status: s.status, currency: s.currency, amount: s._sum?.amount ?? 0 })),
    };
  }

  private where(scope: ScopeFilter, query: ListPaymentsQueryDto): Prisma.PaymentWhereInput {
    const q = searchText(query.q);
    return {
      AND: [
        scope.global ? {} : { organizationId: { in: scope.organizationIds } },
        {
          organizationId: query.organizationId,
          status: query.status,
          purpose: query.purpose,
          methodKey: query.methodKey,
          ...(query.from || query.to ? { paidAt: { gte: query.from, lte: query.to } } : {}),
          ...(q
            ? {
                OR: [
                  { reference: { contains: q, mode: 'insensitive' } },
                  { externalReference: { contains: q, mode: 'insensitive' } },
                  { payerName: { contains: q, mode: 'insensitive' } },
                  { payer: { lastname: { contains: q, mode: 'insensitive' } } },
                  { payer: { firstname: { contains: q, mode: 'insensitive' } } },
                  { payer: { msisdn: { contains: q.replace(/\D/g, '') || q } } },
                ],
              }
            : {}),
        },
      ],
    };
  }

  /**
   * Records money received by the organization. What it pays for must belong
   * to that organization, and a membership can't be paid beyond its price.
   */
  async record(actorId: string, organizationId: string, dto: RecordPaymentDto, db?: Tx) {
    const run = async (tx: Tx) => {
      const method = await tx.paymentMethod.findUnique({ where: { key: dto.methodKey } });
      if (!method?.active) throw new BadRequestException(t('errors.payments.methodInactive'));

      let payerId = dto.payerId ?? null;
      let currency = 'XOF';
      if (dto.purpose === PaymentPurpose.MEMBERSHIP) {
        if (!dto.membershipId) throw new BadRequestException(t('errors.payments.targetRequired'));
        // Lock the period: two cashiers recording at once can't both pass
        // the "no more than what's due" check.
        await tx.$queryRaw`SELECT 1 FROM "Membership" WHERE "id" = ${dto.membershipId} FOR UPDATE`;
        const period = await tx.membership.findUnique({
          where: { id: dto.membershipId },
          include: { member: { select: { userId: true, club: { select: { organizationId: true } } } } },
        });
        if (!period || period.member.club.organizationId !== organizationId) {
          throw new BadRequestException(t('errors.payments.targetMismatch'));
        }
        const remaining = remainingDue(period.priceDue, period.amountPaid);
        if (dto.amount > remaining) {
          throw new BadRequestException(t('errors.payments.overpay', { remaining }));
        }
        payerId ??= period.member.userId;
        currency = period.currency;
      } else if (dto.purpose === PaymentPurpose.TOURNAMENT_ENTRY) {
        if (!dto.participantId) throw new BadRequestException(t('errors.payments.targetRequired'));
        // Lock the entry: no paying the fee twice at two desks.
        await tx.$queryRaw`SELECT 1 FROM "CompetitionParticipant" WHERE "id" = ${dto.participantId} FOR UPDATE`;
        const entry = await tx.competitionParticipant.findUnique({
          where: { id: dto.participantId },
          select: {
            userId: true,
            event: { select: { entryFee: true } },
            competition: { select: { hostOrganizationId: true, currency: true } },
            payments: { where: { status: PaymentStatus.PAID }, select: { amount: true } },
          },
        });
        if (!entry || entry.competition.hostOrganizationId !== organizationId) {
          throw new BadRequestException(t('errors.payments.targetMismatch'));
        }
        const fee = entry.event.entryFee ?? new Prisma.Decimal(0);
        const paid = entry.payments.reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0));
        const remaining = remainingDue(fee, paid);
        if (dto.amount > remaining) {
          throw new BadRequestException(t('errors.payments.overpay', { remaining }));
        }
        payerId ??= entry.userId;
        currency = entry.competition.currency;
      } else if (dto.purpose === PaymentPurpose.BOOKING) {
        if (!dto.bookingId) throw new BadRequestException(t('errors.payments.targetRequired'));
        const booking = await tx.booking.findUnique({
          where: { id: dto.bookingId },
          select: { userId: true, court: { select: { club: { select: { organizationId: true } } } } },
        });
        if (!booking || booking.court.club.organizationId !== organizationId) {
          throw new BadRequestException(t('errors.payments.targetMismatch'));
        }
        payerId ??= booking.userId;
      }

      const payment = await tx.payment.create({
        data: {
          reference: paymentReference(),
          organizationId,
          purpose: dto.purpose,
          status: PaymentStatus.PAID,
          amount: dto.amount,
          currency,
          methodKey: dto.methodKey,
          externalReference: dto.externalReference,
          payerId,
          payerName: dto.payerName,
          paidAt: dto.paidAt ?? new Date(),
          notes: dto.notes,
          recordedById: actorId,
          membershipId: dto.purpose === PaymentPurpose.MEMBERSHIP ? dto.membershipId : null,
          bookingId: dto.purpose === PaymentPurpose.BOOKING ? dto.bookingId : null,
          participantId: dto.purpose === PaymentPurpose.TOURNAMENT_ENTRY ? dto.participantId : null,
        },
        select: paymentSelect,
      });
      if (payment.membershipId) await this.syncMembership(tx, payment.membershipId);
      await this.audit.record(
        {
          actorId,
          action: 'payment.recorded',
          entityType: 'Payment',
          entityId: payment.id,
          organizationId,
          after: {
            reference: payment.reference,
            purpose: payment.purpose,
            amount: payment.amount,
            method: payment.methodKey,
            externalReference: payment.externalReference,
          },
        },
        tx,
      );
      return payment;
    };
    return db ? run(db) : this.prisma.$transaction(run);
  }

  async refund(actorId: string, paymentId: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!payment) throw new NotFoundException(t('errors.payments.notFound'));
      if (payment.status !== PaymentStatus.PAID) throw new ConflictException(t('errors.payments.notRefundable'));
      const updated = await tx.payment.update({
        where: { id: paymentId },
        data: { status: PaymentStatus.REFUNDED, refundedAt: new Date(), refundReason: reason },
        select: paymentSelect,
      });
      if (payment.membershipId) await this.syncMembership(tx, payment.membershipId);
      await this.audit.record(
        {
          actorId,
          action: 'payment.refunded',
          entityType: 'Payment',
          entityId: paymentId,
          organizationId: payment.organizationId,
          before: { status: payment.status },
          after: { status: PaymentStatus.REFUNDED, amount: payment.amount },
          reason,
        },
        tx,
      );
      return updated;
    });
  }

  /** Recomputes a period's amountPaid / fullyPaid from its PAID payments. */
  async syncMembership(tx: Tx, membershipId: string) {
    const [period, sum] = await Promise.all([
      tx.membership.findUniqueOrThrow({ where: { id: membershipId }, select: { priceDue: true } }),
      tx.payment.aggregate({ where: { membershipId, status: PaymentStatus.PAID }, _sum: { amount: true } }),
    ]);
    const paid = sum._sum.amount ?? new Prisma.Decimal(0);
    await tx.membership.update({
      where: { id: membershipId },
      data: { amountPaid: paid, fullyPaid: paid.greaterThanOrEqualTo(period.priceDue) },
    });
  }
}
