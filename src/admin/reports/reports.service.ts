import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AffiliationStatus,
  BookingStatus,
  CompetitionMatchStatus,
  Gender,
  MemberStatus,
  OrganizationType,
  PaymentPurpose,
  PaymentStatus,
  Prisma,
  RegistrationStatus,
} from '@prisma/client';
import { parseOpeningHours, toMinutes, windowsFor } from '../../clubs/opening-hours.js';
import { csvDocument } from '../../common/csv.js';
import { t, type MessageKey } from '../../i18n/i18n.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { formatScore } from '../tournaments/tennis-score.js';

export type ColumnType = 'text' | 'number' | 'money' | 'percent' | 'date';

export interface Report {
  type: string;
  title: string;
  generatedAt: string;
  period: { from: string; to: string } | null;
  columns: { key: string; label: string; type: ColumnType }[];
  rows: Record<string, string | number | null>[];
  totals: Record<string, number> | null;
  /** One series for a bar chart (label → value), when it helps. */
  chart: { label: string; type: ColumnType; points: { label: string; value: number }[] } | null;
}

export const CLUB_REPORTS = ['revenue', 'members', 'occupancy'] as const;
export const TOURNAMENT_REPORTS = ['entries', 'results'] as const;
export const FEDERATION_REPORTS = ['clubs', 'players'] as const;

const DAY = 86_400_000;
const month = (d: Date) => d.toISOString().slice(0, 7);
const col = (key: string, type: ColumnType = 'text') => ({ key, label: t(`reports.columns.${key}` as MessageKey), type });
const sum = (rows: Record<string, string | number | null>[], key: string) => rows.reduce((a, r) => a + Number(r[key] ?? 0), 0);

/** Months [from, to] as YYYY-MM, oldest first. */
function monthsBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  for (let d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1)); d <= to; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    out.push(month(d));
  }
  return out;
}

/**
 * Operational reports as generic tables (columns, rows, totals, one chart
 * series), rendered by the back-office and exported as CSV. Every figure is
 * computed from the live data; nothing is cached.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Report period: [from, to] days, default the last 12 months. */
  period(from?: Date, to?: Date) {
    const end = to ? new Date(to.getTime() + DAY - 1) : new Date();
    const start = from ?? new Date(Date.UTC(end.getUTCFullYear() - 1, end.getUTCMonth() + 1, 1));
    if (start > end) throw new BadRequestException(t('errors.reports.invalidPeriod'));
    return { from: start, to: end };
  }

  // Club -------------------------------------------------------------------

  async club(clubId: string, type: string, from: Date, to: Date): Promise<Report> {
    const club = await this.prisma.club.findUnique({ where: { id: clubId }, select: { id: true, name: true, organizationId: true, openingHours: true } });
    if (!club) throw new NotFoundException(t('errors.clubs.notFound'));
    if (type === 'revenue') return this.revenue(club.organizationId, club.name, from, to);
    if (type === 'members') return this.members(club.id, club.name, from, to);
    return this.occupancy(club, from, to);
  }

  /** Money received per month and purpose, refunds apart. */
  private async revenue(organizationId: string, name: string, from: Date, to: Date): Promise<Report> {
    const payments = await this.prisma.payment.findMany({
      where: { organizationId, paidAt: { gte: from, lte: to }, status: { in: [PaymentStatus.PAID, PaymentStatus.REFUNDED] } },
      select: { paidAt: true, amount: true, purpose: true, status: true },
    });
    const purposes = Object.values(PaymentPurpose);
    const rows = monthsBetween(from, to).map((m) => {
      const inMonth = payments.filter((p) => month(p.paidAt!) === m);
      const kept = inMonth.filter((p) => p.status === PaymentStatus.PAID);
      const row: Record<string, string | number | null> = { month: m };
      for (const purpose of purposes) row[purpose.toLowerCase()] = kept.filter((p) => p.purpose === purpose).reduce((a, p) => a + Number(p.amount), 0);
      row['refunded'] = inMonth.filter((p) => p.status === PaymentStatus.REFUNDED).reduce((a, p) => a + Number(p.amount), 0);
      row['total'] = kept.reduce((a, p) => a + Number(p.amount), 0);
      return row;
    });
    const columns = [col('month'), ...purposes.map((p) => ({ key: p.toLowerCase(), label: t(`reports.purposes.${p}` as MessageKey), type: 'money' as const })), col('refunded', 'money'), col('total', 'money')];
    return this.build('revenue', name, from, to, columns, rows, ['refunded', 'total', ...purposes.map((p) => p.toLowerCase())], {
      label: t('reports.columns.total'),
      type: 'money',
      points: rows.map((r) => ({ label: String(r['month']), value: Number(r['total']) })),
    });
  }

  /** Members per plan: current ones, and those who joined in the period. */
  private async members(clubId: string, name: string, from: Date, to: Date): Promise<Report> {
    const now = new Date();
    const [plans, members] = await Promise.all([
      this.prisma.membershipPlan.findMany({ where: { clubId }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      this.prisma.clubMember.findMany({
        where: { clubId },
        select: { status: true, joinedAt: true, currentMembership: { select: { planId: true, expiresAt: true, fullyPaid: true } } },
      }),
    ]);
    const rows = [...plans, { id: null, name: t('reports.noPlan') }].map((plan) => {
      const onPlan = members.filter((m) => (m.currentMembership?.planId ?? null) === plan.id);
      return {
        plan: plan.name,
        active: onPlan.filter((m) => m.status === MemberStatus.ACTIVE && m.currentMembership && m.currentMembership.expiresAt >= now).length,
        expired: onPlan.filter((m) => m.status !== MemberStatus.LEFT && m.currentMembership && m.currentMembership.expiresAt < now).length,
        unpaid: onPlan.filter((m) => m.status !== MemberStatus.LEFT && m.currentMembership && !m.currentMembership.fullyPaid).length,
        joined: onPlan.filter((m) => m.joinedAt >= from && m.joinedAt <= to).length,
      };
    }).filter((r) => r.active + r.expired + r.joined > 0 || r.plan !== t('reports.noPlan'));
    const byMonth = monthsBetween(from, to).map((m) => ({ label: m, value: members.filter((x) => month(x.joinedAt) === m).length }));
    return this.build('members', name, from, to, [col('plan'), col('active', 'number'), col('expired', 'number'), col('unpaid', 'number'), col('joined', 'number')], rows, ['active', 'expired', 'unpaid', 'joined'], {
      label: t('reports.columns.joined'),
      type: 'number',
      points: byMonth,
    });
  }

  /** Hours each court was open, booked and used by tournaments in the period. */
  private async occupancy(club: { id: string; name: string; openingHours: Prisma.JsonValue }, from: Date, to: Date): Promise<Report> {
    const courts = await this.prisma.court.findMany({
      where: { clubId: club.id, archivedAt: null },
      orderBy: [{ number: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        availability: { select: { weekday: true, opensAt: true, closesAt: true } },
        bookings: { where: { status: { not: BookingStatus.CANCELLED }, startTime: { lt: to }, endTime: { gt: from } }, select: { startTime: true, endTime: true } },
        competitionMatches: {
          where: { scheduledAt: { gte: from, lte: to }, status: { notIn: [CompetitionMatchStatus.POSTPONED, CompetitionMatchStatus.BYE] } },
          select: { round: { select: { event: { select: { matchDurationMinutes: true } } } } },
        },
      },
    });
    const hours = parseOpeningHours(club.openingHours);
    const rows = courts.map((court) => {
      let open = 0;
      for (let d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())); d <= to; d = new Date(d.getTime() + DAY)) {
        open += windowsFor(d, court.availability, hours).reduce((a, w) => a + (toMinutes(w.closesAt) - toMinutes(w.opensAt)) / 60, 0);
      }
      const booked = court.bookings.reduce((a, b) => a + (Math.min(b.endTime.getTime(), to.getTime()) - Math.max(b.startTime.getTime(), from.getTime())) / 3_600_000, 0);
      const tournament = court.competitionMatches.reduce((a, m) => a + m.round.event.matchDurationMinutes / 60, 0);
      return {
        court: court.name,
        open_hours: Math.round(open),
        booked_hours: Math.round(booked * 10) / 10,
        tournament_hours: Math.round(tournament * 10) / 10,
        utilization: open ? Math.round(((booked + tournament) / open) * 1000) / 10 : 0,
      };
    });
    return this.build('occupancy', club.name, from, to, [col('court'), col('open_hours', 'number'), col('booked_hours', 'number'), col('tournament_hours', 'number'), col('utilization', 'percent')], rows, ['open_hours', 'booked_hours', 'tournament_hours'], {
      label: t('reports.columns.utilization'),
      type: 'percent',
      points: rows.map((r) => ({ label: r.court, value: r.utilization })),
    });
  }

  // Tournament ---------------------------------------------------------------

  async tournament(competitionId: string, type: string): Promise<Report> {
    const competition = await this.prisma.competition.findUnique({ where: { id: competitionId }, select: { id: true, name: true, startDate: true, endDate: true } });
    if (!competition) throw new NotFoundException(t('errors.tournaments.notFound'));
    return type === 'results' ? this.results(competition) : this.entries(competition);
  }

  /** Per table: entries by status, fees due and collected. */
  private async entries(c: { id: string; name: string; startDate: Date; endDate: Date }): Promise<Report> {
    const events = await this.prisma.competitionEvent.findMany({
      where: { competitionId: c.id },
      orderBy: { tableOrder: 'asc' },
      select: {
        name: true,
        entryFee: true,
        maxEntries: true,
        entries: { select: { status: true, payments: { where: { status: PaymentStatus.PAID }, select: { amount: true } } } },
      },
    });
    const rows = events.map((e) => {
      const count = (s: RegistrationStatus) => e.entries.filter((x) => x.status === s).length;
      const approved = count(RegistrationStatus.APPROVED);
      const due = approved * Number(e.entryFee ?? 0);
      const collected = e.entries.reduce((a, x) => a + x.payments.reduce((b, p) => b + Number(p.amount), 0), 0);
      return {
        table: e.name,
        places: e.maxEntries,
        approved,
        pending: count(RegistrationStatus.PENDING),
        waitlisted: count(RegistrationStatus.WAITLISTED),
        withdrawn: count(RegistrationStatus.WITHDRAWN) + count(RegistrationStatus.REJECTED),
        fees_due: due,
        fees_collected: collected,
        outstanding: Math.max(0, due - collected),
      };
    });
    return this.build(
      'entries',
      c.name,
      c.startDate,
      c.endDate,
      [col('table'), col('places', 'number'), col('approved', 'number'), col('pending', 'number'), col('waitlisted', 'number'), col('withdrawn', 'number'), col('fees_due', 'money'), col('fees_collected', 'money'), col('outstanding', 'money')],
      rows,
      ['approved', 'pending', 'waitlisted', 'withdrawn', 'fees_due', 'fees_collected', 'outstanding'],
      { label: t('reports.columns.approved'), type: 'number', points: rows.map((r) => ({ label: r.table, value: r.approved })) },
    );
  }

  /** Every played or decided match with its score. */
  private async results(c: { id: string; name: string; startDate: Date; endDate: Date }): Promise<Report> {
    const matches = await this.prisma.competitionMatch.findMany({
      where: { round: { competitionId: c.id }, status: { not: CompetitionMatchStatus.BYE } },
      orderBy: [{ round: { event: { tableOrder: 'asc' } } }, { round: { orderIndex: 'asc' } }, { position: 'asc' }],
      select: {
        status: true,
        outcome: true,
        scheduledAt: true,
        winnerId: true,
        participant1Id: true,
        court: { select: { name: true } },
        round: { select: { name: true, event: { select: { name: true } } } },
        participant1: { select: { user: { select: { firstname: true, lastname: true } } } },
        participant2: { select: { user: { select: { firstname: true, lastname: true } } } },
        sets: { orderBy: { setNumber: 'asc' }, select: { side1Games: true, side2Games: true, tiebreak1: true, tiebreak2: true, isSuperTiebreak: true } },
      },
    });
    const who = (p: { user: { firstname: string; lastname: string } } | null) => (p ? `${p.user.firstname} ${p.user.lastname}` : '');
    const rows = matches.map((m) => ({
      table: m.round.event.name,
      round: m.round.name,
      player1: who(m.participant1),
      player2: who(m.participant2),
      score: m.outcome === 'WALKOVER' ? 'W.O.' : formatScore(m.sets.map((s) => ({ side1: s.side1Games, side2: s.side2Games, tiebreak1: s.tiebreak1, tiebreak2: s.tiebreak2, superTiebreak: s.isSuperTiebreak }))) + (m.outcome === 'RETIRED' ? ' ab.' : ''),
      winner: m.winnerId ? (m.winnerId === m.participant1Id ? who(m.participant1) : who(m.participant2)) : '',
      court: m.court?.name ?? '',
      scheduled: m.scheduledAt ? m.scheduledAt.toISOString() : null,
      status: t(`reports.matchStatus.${m.status}` as MessageKey),
    }));
    return this.build('results', c.name, c.startDate, c.endDate, [col('table'), col('round'), col('player1'), col('player2'), col('score'), col('winner'), col('court'), col('scheduled', 'date'), col('status')], rows, [], null);
  }

  // Federation ---------------------------------------------------------------

  async federation(federationId: string, type: string, from: Date, to: Date): Promise<Report> {
    const federation = await this.prisma.organization.findUnique({ where: { id: federationId }, select: { name: true, type: true } });
    if (!federation || federation.type !== OrganizationType.FEDERATION) {
      throw new NotFoundException(t('errors.organizations.wrongType', { type: OrganizationType.FEDERATION }));
    }
    return type === 'players' ? this.players(federationId, federation.name, from, to) : this.clubs(federationId, federation.name, from, to);
  }

  /** Affiliated clubs: members in good standing, courts, tournaments hosted. */
  private async clubs(federationId: string, name: string, from: Date, to: Date): Promise<Report> {
    const now = new Date();
    const affiliations = await this.prisma.organizationAffiliation.findMany({
      where: { parentOrgId: federationId, status: { in: [AffiliationStatus.ACTIVE, AffiliationStatus.PENDING] } },
      select: {
        status: true,
        member: {
          select: {
            name: true,
            club: {
              select: {
                city: { select: { name: true } },
                _count: { select: { courts: { where: { archivedAt: null } }, members: { where: { status: MemberStatus.ACTIVE, currentMembership: { is: { expiresAt: { gte: now } } } } } } },
              },
            },
            _count: { select: { competitions: { where: { startDate: { gte: from, lte: to } } } } },
          },
        },
      },
      orderBy: { member: { name: 'asc' } },
    });
    const rows = affiliations.map((a) => ({
      club: a.member.name,
      city: a.member.club?.city.name ?? '',
      affiliation: t(`reports.affiliation.${a.status}` as MessageKey),
      members: a.member.club?._count.members ?? 0,
      courts: a.member.club?._count.courts ?? 0,
      tournaments: a.member._count.competitions,
    }));
    return this.build('clubs', name, from, to, [col('club'), col('city'), col('affiliation'), col('members', 'number'), col('courts', 'number'), col('tournaments', 'number')], rows, ['members', 'courts', 'tournaments'], {
      label: t('reports.columns.members'),
      type: 'number',
      points: rows.map((r) => ({ label: r.club, value: r.members })),
    });
  }

  /** Federation players by classification and gender. */
  private async players(federationId: string, name: string, from: Date, to: Date): Promise<Report> {
    const now = new Date();
    const [scale, users] = await Promise.all([
      this.prisma.classification.findMany({ orderBy: { rank: 'asc' }, select: { id: true, code: true } }),
      this.prisma.user.findMany({
        where: {
          clubMemberships: {
            some: {
              status: MemberStatus.ACTIVE,
              currentMembership: { is: { expiresAt: { gte: now } } },
              club: { organization: { status: 'ACTIVE', memberships: { some: { parentOrgId: federationId, status: AffiliationStatus.ACTIVE } } } },
            },
          },
        },
        select: { playerProfile: { select: { gender: true, classificationId: true } } },
      }),
    ]);
    // Players without a classification count as NC.
    const nc = scale.find((c) => c.code === 'NC')?.id ?? null;
    const rows = scale
      .map((c) => {
        const here = users.filter((u) => (u.playerProfile?.classificationId ?? nc) === c.id);
        return {
          classification: c.code,
          men: here.filter((u) => u.playerProfile?.gender === Gender.MALE).length,
          women: here.filter((u) => u.playerProfile?.gender === Gender.FEMALE).length,
          unknown: here.filter((u) => !u.playerProfile?.gender).length,
          total: here.length,
        };
      })
      .filter((r) => r.total > 0);
    return this.build('players', name, from, to, [col('classification'), col('men', 'number'), col('women', 'number'), col('unknown', 'number'), col('total', 'number')], rows, ['men', 'women', 'unknown', 'total'], {
      label: t('reports.columns.total'),
      type: 'number',
      points: rows.map((r) => ({ label: r.classification, value: r.total })),
    });
  }

  // Output ---------------------------------------------------------------------

  private build(
    type: string,
    subject: string,
    from: Date | null,
    to: Date | null,
    columns: Report['columns'],
    rows: Report['rows'],
    totalKeys: string[],
    chart: Report['chart'],
  ): Report {
    return {
      type,
      title: `${t(`reports.types.${type}` as MessageKey)} · ${subject}`,
      generatedAt: new Date().toISOString(),
      period: from && to ? { from: from.toISOString(), to: to.toISOString() } : null,
      columns,
      rows,
      totals: totalKeys.length ? Object.fromEntries(totalKeys.map((k) => [k, Math.round(sum(rows, k) * 100) / 100])) : null,
      chart,
    };
  }

  /** CSV with the report's (localized) column labels and a totals line. */
  csv(report: Report): string {
    const rows = report.rows.map((r) => report.columns.map((c) => r[c.key]));
    if (report.totals) rows.push(report.columns.map((c, i) => (i === 0 ? t('reports.totalRow') : (report.totals![c.key] ?? null))));
    return csvDocument(report.columns.map((c) => c.label), rows);
  }
}
