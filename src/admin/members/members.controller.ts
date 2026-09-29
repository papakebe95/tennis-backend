import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthenticatedUser } from '../../auth/jwt.strategy.js';
import { Authorize, CurrentGrants } from '../../authz/permission.guard.js';
import { scopeFilter, type Grant } from '../../authz/scope.js';
import { csvDocument } from '../../common/csv.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { t } from '../../i18n/i18n.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ClubOpsService } from './club-ops.service.js';
import {
  CancelBookingDto,
  CandidateQueryDto,
  CreateMemberDto,
  CreatePlanDto,
  FederationPlayersQueryDto,
  ListBookingsQueryDto,
  ListMembersQueryDto,
  ListPaymentsQueryDto,
  MemberStatusDto,
  PlanDto,
  RecordPaymentDto,
  RefundDto,
  RenewMemberDto,
  UpdateMemberDto,
} from './members.dto.js';
import { MembersService } from './members.service.js';
import { PaymentsService } from './payments.service.js';

const sendCsv = (res: Response, filename: string, csv: string) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return csv;
};

/** Club-scoped operations; `:id` is the club id. */
@Controller('admin/clubs')
export class ClubMembersController {
  constructor(
    private readonly members: MembersService,
    private readonly payments: PaymentsService,
    private readonly ops: ClubOpsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get(':id/dashboard')
  @Authorize('club.dashboard.view', { resource: 'club' })
  dashboard(@Param('id') id: string) {
    return this.ops.dashboard(id);
  }

  @Get(':id/membership-plans')
  @Authorize('member.view', { resource: 'club' })
  plans(@Param('id') id: string) {
    return this.members.plans(id);
  }

  @Post(':id/membership-plans')
  @Authorize('membership.plan.manage', { resource: 'club' })
  createPlan(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: CreatePlanDto) {
    return this.members.createPlan(user.userId, id, dto);
  }

  @Get(':id/member-candidates')
  @Authorize('member.manage', { resource: 'club' })
  candidates(@Param('id') id: string, @Query() query: CandidateQueryDto) {
    return this.members.candidates(id, query.q);
  }

  @Get(':id/members')
  @Authorize('member.view', { resource: 'club' })
  async list(@Param('id') id: string, @Query() query: ListMembersQueryDto, @Res({ passthrough: true }) res: Response) {
    if (query.format === 'csv') return sendCsv(res, 'members.csv', await this.members.listCsv(id, query));
    return this.members.list(id, query);
  }

  @Post(':id/members')
  @Authorize('member.manage', { resource: 'club' })
  create(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: CreateMemberDto) {
    return this.members.create(user.userId, id, dto);
  }

  @Get(':id/bookings')
  @Authorize('booking.view', { resource: 'club' })
  bookings(@Param('id') id: string, @Query() query: ListBookingsQueryDto) {
    return this.ops.bookings(id, query);
  }

  @Post(':id/payments')
  @Authorize('payment.record', { resource: 'club' })
  async recordPayment(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: RecordPaymentDto) {
    const club = await this.prisma.club.findUnique({ where: { id }, select: { organizationId: true } });
    if (!club) throw new NotFoundException(t('errors.clubs.notFound'));
    return this.payments.record(user.userId, club.organizationId, dto);
  }
}

@Controller('admin/members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get(':memberId')
  @Authorize('member.view', { resource: 'member', param: 'memberId' })
  detail(@Param('memberId') memberId: string) {
    return this.members.detail(memberId);
  }

  @Patch(':memberId')
  @Authorize('member.manage', { resource: 'member', param: 'memberId' })
  update(@CurrentUser() user: AuthenticatedUser, @Param('memberId') memberId: string, @Body() dto: UpdateMemberDto) {
    return this.members.update(user.userId, memberId, dto);
  }

  @Patch(':memberId/status')
  @Authorize('member.manage', { resource: 'member', param: 'memberId' })
  setStatus(@CurrentUser() user: AuthenticatedUser, @Param('memberId') memberId: string, @Body() dto: MemberStatusDto) {
    return this.members.setStatus(user.userId, memberId, dto);
  }

  @Post(':memberId/renew')
  @Authorize('member.manage', { resource: 'member', param: 'memberId' })
  renew(@CurrentUser() user: AuthenticatedUser, @Param('memberId') memberId: string, @Body() dto: RenewMemberDto) {
    return this.members.renew(user.userId, memberId, dto);
  }
}

@Controller('admin/membership-plans')
export class MembershipPlansController {
  constructor(private readonly members: MembersService) {}

  @Patch(':planId')
  @Authorize('membership.plan.manage', { resource: 'membershipPlan', param: 'planId' })
  update(@CurrentUser() user: AuthenticatedUser, @Param('planId') planId: string, @Body() dto: PlanDto) {
    return this.members.updatePlan(user.userId, planId, dto);
  }
}

@Controller('admin/payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /** Payments the caller may see (their organizations, or all with a global grant). */
  @Get()
  @Authorize('payment.view', { anywhere: true })
  async list(
    @CurrentGrants() grants: Grant[],
    @Query() query: ListPaymentsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const page = await this.payments.list(scopeFilter(grants, 'payment.view'), query);
    if (query.format !== 'csv') return page;
    const header = ['reference', 'paid_at', 'organization', 'purpose', 'status', 'amount', 'currency', 'method', 'external_reference', 'payer', 'phone', 'recorded_by'];
    return sendCsv(res, 'payments.csv', csvDocument(header, page.items.map((p) => [
        p.reference,
        p.paidAt?.toISOString(),
        p.organization.name,
        p.purpose,
        p.status,
        p.amount,
        p.currency,
        p.method.label,
        p.externalReference,
        p.payer ? `${p.payer.firstname} ${p.payer.lastname}` : p.payerName,
        p.payer?.msisdn,
        p.recordedBy ? `${p.recordedBy.firstname} ${p.recordedBy.lastname}` : '',
      ])));
  }

  @Get('methods')
  @Authorize('payment.view', { anywhere: true })
  methods() {
    return this.payments.methods();
  }

  @Post(':paymentId/refund')
  @HttpCode(HttpStatus.OK)
  @Authorize('payment.refund', { resource: 'payment', param: 'paymentId' })
  refund(@CurrentUser() user: AuthenticatedUser, @Param('paymentId') paymentId: string, @Body() dto: RefundDto) {
    return this.payments.refund(user.userId, paymentId, dto.reason);
  }
}

@Controller('admin/bookings')
export class BookingsAdminController {
  constructor(private readonly ops: ClubOpsService) {}

  @Post(':bookingId/cancel')
  @HttpCode(HttpStatus.OK)
  @Authorize('booking.manage', { resource: 'booking', param: 'bookingId' })
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('bookingId') bookingId: string, @Body() dto: CancelBookingDto) {
    return this.ops.cancelBooking(user.userId, bookingId, dto.reason);
  }
}

@Controller('admin/federations')
export class FederationPlayersController {
  constructor(private readonly ops: ClubOpsService) {}

  @Get(':id/players')
  @Authorize('federation.players.view', { resource: 'organization' })
  players(@Param('id') id: string, @Query() query: FederationPlayersQueryDto) {
    return this.ops.federationPlayers(id, query);
  }
}
