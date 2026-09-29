import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  BookingStatus,
  CompetitionMatchStatus as M,
  CompetitionStatus,
  CourtStatus,
  EventDiscipline,
  MatchOutcome,
  MatchStatus,
  PlayerSide,
  Prisma,
  RecordedMatchType,
  ResultStatus,
  RoleScope,
} from '@prisma/client';
import { AuditService } from '../../audit/audit.service.js';
import { AuthzService } from '../../authz/authz.service.js';
import type { PermissionKey } from '../../authz/permissions.js';
import { holds, type Grant, type Scope } from '../../authz/scope.js';
import { pageArgs, searchText, toPage } from '../../common/pagination.js';
import { personSearchWhere } from '../../common/person-search.js';
import { t } from '../../i18n/i18n.js';
import { matchNotification, type MatchNotificationKey } from '../../notifications/notification-messages.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { fitsWindows, parseOpeningHours, windowsFor } from '../../clubs/opening-hours.js';
import { matchBlocks, overlaps } from './court-occupancy.js';
import type { ListMatchesQueryDto, MatchResultDto, ScheduleMatchDto } from './matches.dto.js';
import { checkResult, formatScore, type SetScore } from './tennis-score.js';

type Tx = Prisma.TransactionClient;

const conflict = (key: Parameters<typeof t>[0], code: string, extra: object = {}) =>
  new ConflictException({ message: t(key), code, ...extra });

/** Nobody has played yet. */
const NOT_STARTED: M[] = [M.PENDING, M.READY, M.SCHEDULED, M.POSTPONED];
/** The tournament is being played (results can be recorded). */
const PLAYING: CompetitionStatus[] = [CompetitionStatus.IN_PROGRESS, CompetitionStatus.INTERRUPTED];

const sideSelect = {
  id: true,
  seed: true,
  entryType: true,
  userId: true,
  partnerUserId: true,
  user: { select: { id: true, firstname: true, lastname: true, playerProfile: { select: { avatarUrl: true, classification: { select: { code: true } } } } } },
  partner: { select: { id: true, firstname: true, lastname: true } },
} satisfies Prisma.CompetitionParticipantSelect;

const person = { select: { id: true, firstname: true, lastname: true } } as const;

const matchSelect = {
  id: true,
  position: true,
  status: true,
  outcome: true,
  resultStatus: true,
  loserSide: true,
  scheduledAt: true,
  startedAt: true,
  completedAt: true,
  version: true,
  notes: true,
  disputeReason: true,
  nextMatchId: true,
  nextSlot: true,
  winnerId: true,
  participant1Id: true,
  participant2Id: true,
  resultEnteredAt: true,
  resultValidatedAt: true,
  participant1: { select: sideSelect },
  participant2: { select: sideSelect },
  court: { select: { id: true, name: true, number: true, club: { select: { id: true, name: true } } } },
  official: person,
  sets: { orderBy: { setNumber: 'asc' }, select: { setNumber: true, side1Games: true, side2Games: true, tiebreak1: true, tiebreak2: true, isSuperTiebreak: true } },
  round: {
    select: {
      orderIndex: true,
      name: true,
      event: {
        select: {
          id: true,
          name: true,
          discipline: true,
          bestOf: true,
          gamesPerSet: true,
          finalSet: true,
          noAd: true,
          matchDurationMinutes: true,
          drawSize: true,
        },
      },
      competition: { select: { id: true, name: true, status: true, hostOrganizationId: true, clubId: true } },
    },
  },
} satisfies Prisma.CompetitionMatchSelect;

type MatchRow = Prisma.CompetitionMatchGetPayload<{ select: typeof matchSelect }>;
type SideRow = NonNullable<MatchRow['participant1']>;

const sideView = (e: SideRow | null) =>
  e && {
    id: e.id,
    seed: e.seed,
    entryType: e.entryType,
    player: {
      id: e.user.id,
      firstname: e.user.firstname,
      lastname: e.user.lastname,
      avatarUrl: e.user.playerProfile?.avatarUrl ?? null,
      classification: e.user.playerProfile?.classification?.code ?? null,
    },
    partner: e.partner,
  };

const usersOf = (e: SideRow | null) => (e ? [e.userId, ...(e.partnerUserId ? [e.partnerUserId] : [])] : []);
const nameOf = (e: SideRow | null) => (e ? `${e.user.firstname} ${e.user.lastname}${e.partner ? ` / ${e.partner.firstname} ${e.partner.lastname}` : ''}` : '');

/**
 * Tournament matches: listing, scheduling on courts, officials, and results
 * — entered, validated, corrected or disputed — with the winner moving on
 * in the bracket.
 */
@Injectable()
export class MatchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // Reading -------------------------------------------------------------

  /**
   * Matches the actor may see. Officials (grants carrying
   * `match.assigned_only`) only see the matches they are assigned to.
   */
  async list(grants: readonly Grant[], actorId: string, query: ListMatchesQueryDto) {
    const where: Prisma.CompetitionMatchWhereInput = {
      AND: [
        this.visibleWhere(grants, actorId),
        query.competitionId ? { round: { competitionId: query.competitionId } } : {},
        query.eventId ? { round: { eventId: query.eventId } } : {},
        query.status ? { status: query.status } : query.includeByes === 'true' ? {} : { status: { not: M.BYE } },
        query.resultStatus ? { resultStatus: query.resultStatus } : {},
        query.courtId ? { courtId: query.courtId } : {},
        query.mine === 'true' ? { officialUserId: actorId } : {},
        query.date
          ? { scheduledAt: { gte: new Date(`${query.date}T00:00:00Z`), lt: new Date(new Date(`${query.date}T00:00:00Z`).getTime() + 86_400_000) } }
          : {},
        searchText(query.q)
          ? {
              OR: [
                { participant1: { OR: [{ user: personSearchWhere(query.q!) }, { partner: personSearchWhere(query.q!) }] } },
                { participant2: { OR: [{ user: personSearchWhere(query.q!) }, { partner: personSearchWhere(query.q!) }] } },
              ],
            }
          : {},
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.competitionMatch.findMany({
        where,
        orderBy: [{ scheduledAt: { sort: 'asc', nulls: 'last' } }, { round: { orderIndex: 'asc' } }, { position: 'asc' }],
        ...pageArgs(query),
        select: matchSelect,
      }),
      this.prisma.competitionMatch.count({ where }),
    ]);
    return toPage(rows.map((m) => this.view(m)), total, query);
  }

  async detail(grants: readonly Grant[], actorId: string, id: string) {
    const match = await this.load(this.prisma, id);
    await this.assertMayView(grants, actorId, match);
    const [activity, placeholders] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: { entityType: 'CompetitionMatch', entityId: id },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, action: true, createdAt: true, reason: true, after: true, actor: person },
      }),
      match.round.orderIndex === 1
        ? this.prisma.drawSlot.findMany({
            where: { eventId: match.round.event.id, position: { in: [2 * match.position, 2 * match.position + 1] } },
            select: { position: true, kind: true, label: true },
          })
        : Promise.resolve([]),
    ]);
    return { ...this.view(match), activity, placeholders };
  }

  /** People who can officiate this tournament's matches. */
  async officials(competitionId: string) {
    const grants = await this.prisma.userRole.findMany({
      where: {
        revokedAt: null,
        OR: [{ competitionId }, { organization: { competitions: { some: { id: competitionId } } } }],
        role: { permissions: { some: { permissionKey: 'match.result.enter' } } },
      },
      select: { user: person, role: { select: { name: true, scope: true } } },
    });
    const byUser = new Map<string, { id: string; firstname: string; lastname: string; roles: string[] }>();
    for (const g of grants) {
      const entry = byUser.get(g.user.id) ?? { ...g.user, roles: [] };
      entry.roles.push(g.role.name);
      byUser.set(g.user.id, entry);
    }
    return [...byUser.values()].sort((a, b) => a.lastname.localeCompare(b.lastname));
  }

  // Scheduling ------------------------------------------------------------

  /**
   * Puts a match on a court at a time. Refused (409 SCHEDULE_CONFLICT, with
   * the conflicts) when the court is taken by another match or a booking,
   * or a player is already playing then; the court must be available and one
   * of the tournament's courts.
   */
  async schedule(actorId: string, id: string, dto: ScheduleMatchDto) {
    const match = await this.load(this.prisma, id);
    if (match.status === M.COMPLETED || match.status === M.BYE || match.status === M.LIVE) {
      throw conflict('errors.tournamentMatches.cannotSchedule', 'MATCH_NOT_SCHEDULABLE');
    }
    this.assertTournamentOpen(match);
    const court = await this.prisma.court.findUnique({
      where: { id: dto.courtId },
      select: {
        id: true,
        name: true,
        status: true,
        archivedAt: true,
        clubId: true,
        availability: { select: { weekday: true, opensAt: true, closesAt: true } },
        club: { select: { openingHours: true } },
      },
    });
    if (!court) throw new NotFoundException(t('errors.courts.notFound'));
    const allowed = await this.allowedCourtIds(match.round.competition.id, match.round.competition.clubId);
    if (!allowed.includes(court.id)) throw new BadRequestException({ message: t('errors.tournamentMatches.courtNotAllowed'), code: 'COURT_NOT_ALLOWED' });
    if (court.status !== CourtStatus.AVAILABLE || court.archivedAt) throw conflict('errors.courts.unavailable', 'COURT_UNAVAILABLE');

    const start = dto.scheduledAt;
    const end = new Date(start.getTime() + match.round.event.matchDurationMinutes * 60_000);
    const windows = windowsFor(start, court.availability, parseOpeningHours(court.club.openingHours));
    const conflicts = [
      ...(fitsWindows(start, end, windows) ? [] : [{ type: 'HOURS', label: windows.map((w) => `${w.opensAt}–${w.closesAt}`).join(', ') || '—', start, end }]),
      ...(await this.conflicts(match, court.id, start, end)),
    ];
    if (conflicts.length) throw conflict('errors.tournamentMatches.scheduleConflict', 'SCHEDULE_CONFLICT', { conflicts });

    const status = match.participant1Id && match.participant2Id ? M.SCHEDULED : M.PENDING;
    await this.prisma.$transaction(async (tx) => {
      await tx.competitionMatch.update({
        where: { id },
        data: { scheduledAt: start, courtId: court.id, status: match.status === M.POSTPONED || match.status === M.READY || match.status === M.SCHEDULED ? status : match.status, version: { increment: 1 } },
      });
      await this.record(tx, actorId, match, 'match.scheduled', {
        before: { scheduledAt: match.scheduledAt, court: match.court?.name ?? null },
        after: { scheduledAt: start, court: court.name },
      });
    });
    if (status === M.SCHEDULED) await this.notifyPlayers(match, 'matchScheduled', { court: court.name, start: start.toISOString() });
    return this.detailInternal(id);
  }

  async unschedule(actorId: string, id: string) {
    const match = await this.load(this.prisma, id);
    if (!NOT_STARTED.includes(match.status)) throw conflict('errors.tournamentMatches.cannotSchedule', 'MATCH_NOT_SCHEDULABLE');
    await this.prisma.$transaction(async (tx) => {
      await tx.competitionMatch.update({
        where: { id },
        data: { scheduledAt: null, courtId: null, status: match.status === M.SCHEDULED ? M.READY : match.status, version: { increment: 1 } },
      });
      await this.record(tx, actorId, match, 'match.unscheduled', { before: { scheduledAt: match.scheduledAt, court: match.court?.name ?? null } });
    });
    return this.detailInternal(id);
  }

  async postpone(actorId: string, id: string, reason: string) {
    const match = await this.load(this.prisma, id);
    if (match.status === M.COMPLETED || match.status === M.BYE) throw conflict('errors.tournamentMatches.cannotPostpone', 'MATCH_NOT_POSTPONABLE');
    await this.prisma.$transaction(async (tx) => {
      await tx.competitionMatch.update({
        where: { id },
        data: { status: M.POSTPONED, scheduledAt: null, courtId: null, startedAt: null, version: { increment: 1 } },
      });
      await this.record(tx, actorId, match, 'match.postponed', { before: { status: match.status, scheduledAt: match.scheduledAt }, reason });
    });
    await this.notifyPlayers(match, 'matchPostponed', { reason });
    return this.detailInternal(id);
  }

  async start(grants: readonly Grant[], actorId: string, id: string) {
    const match = await this.load(this.prisma, id);
    await this.assertAssigned(grants, actorId, match, 'match.result.enter');
    if (!match.round.competition.status || match.round.competition.status !== CompetitionStatus.IN_PROGRESS) {
      throw conflict('errors.tournamentMatches.notPlaying', 'TOURNAMENT_NOT_IN_PROGRESS');
    }
    if (match.status !== M.READY && match.status !== M.SCHEDULED) throw conflict('errors.tournamentMatches.cannotStart', 'MATCH_NOT_READY');
    await this.prisma.$transaction(async (tx) => {
      await tx.competitionMatch.update({ where: { id }, data: { status: M.LIVE, startedAt: new Date(), version: { increment: 1 } } });
      await this.record(tx, actorId, match, 'match.started', {});
    });
    return this.detailInternal(id);
  }

  async assignOfficial(actorId: string, id: string, userId: string | null) {
    const match = await this.load(this.prisma, id);
    if (userId) {
      const chain = await this.authz.scopeChain('competition', match.round.competition.id);
      const grants = await this.authz.loadGrants(userId);
      if (!holds(grants, 'match.result.enter', chain)) {
        throw new BadRequestException({ message: t('errors.tournamentMatches.officialNotAllowed'), code: 'OFFICIAL_NOT_ALLOWED' });
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.competitionMatch.update({ where: { id }, data: { officialUserId: userId, version: { increment: 1 } } });
      await this.record(tx, actorId, match, 'match.official.assigned', { before: { official: match.official?.id ?? null }, after: { official: userId } });
    });
    return this.detailInternal(id);
  }

  // Results ---------------------------------------------------------------

  /**
   * Records a result. Someone allowed to validate results (director,
   * organizer) validates it at once; an official's result waits for
   * validation. Correcting a validated result needs validation rights and a
   * reason, and is refused once the winner's next match has started.
   */
  async enterResult(grants: readonly Grant[], actorId: string, id: string, dto: MatchResultDto) {
    const match = await this.load(this.prisma, id);
    const chain = await this.authz.scopeChain('match', id);
    await this.assertAssigned(grants, actorId, match, 'match.result.enter');
    const mayValidate = holds(grants, 'match.result.validate', chain);
    if (!PLAYING.includes(match.round.competition.status)) throw conflict('errors.tournamentMatches.notPlaying', 'TOURNAMENT_NOT_IN_PROGRESS');
    if (!match.participant1Id || !match.participant2Id) throw conflict('errors.tournamentMatches.sidesUnknown', 'SIDES_UNKNOWN');
    if (match.status === M.BYE) throw conflict('errors.tournamentMatches.cannotScore', 'MATCH_IS_BYE');
    const correcting = match.resultStatus === ResultStatus.VALIDATED;
    if (correcting) {
      if (!mayValidate) throw new ForbiddenException({ message: t('errors.tournamentMatches.correctionForbidden'), code: 'FORBIDDEN' });
      if (!dto.reason?.trim()) throw new BadRequestException({ message: t('errors.tournaments.reasonRequired'), code: 'REASON_REQUIRED' });
    }

    const sets: SetScore[] = dto.sets.map((s) => ({ side1: s.side1, side2: s.side2, tiebreak1: s.tiebreak1 ?? null, tiebreak2: s.tiebreak2 ?? null, superTiebreak: !!s.superTiebreak }));
    const check = checkResult(match.round.event, dto.outcome, sets, dto.loserSide ?? null);
    if (!check.ok) {
      throw new BadRequestException({ message: t('errors.tournamentMatches.invalidScore'), code: 'SCORE_INVALID', issues: check.errors });
    }

    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, id, dto.version);
      await tx.competitionMatchSet.deleteMany({ where: { matchId: id } });
      if (sets.length) {
        await tx.competitionMatchSet.createMany({
          data: sets.map((s, i) => ({
            matchId: id,
            setNumber: i + 1,
            side1Games: s.side1,
            side2Games: s.side2,
            tiebreak1: s.tiebreak1 ?? null,
            tiebreak2: s.tiebreak2 ?? null,
            isSuperTiebreak: !!s.superTiebreak,
          })),
        });
      }
      await tx.competitionMatch.update({
        where: { id },
        data: {
          outcome: dto.outcome,
          loserSide: dto.outcome === MatchOutcome.PLAYED ? null : dto.loserSide,
          notes: dto.notes ?? match.notes,
          resultStatus: ResultStatus.ENTERED,
          resultEnteredById: actorId,
          resultEnteredAt: new Date(),
          disputeReason: null,
          version: { increment: 1 },
        },
      });
      await this.record(tx, actorId, match, correcting ? 'match.result.corrected' : 'match.result.entered', {
        before: correcting ? { score: formatScore(match.sets.map(toScore)), winnerId: match.winnerId } : undefined,
        after: { outcome: dto.outcome, score: formatScore(sets), winnerSide: check.winnerSide },
        reason: dto.reason,
      });
      if (mayValidate) await this.finalize(tx, actorId, id);
    });
    if (mayValidate) await this.afterValidation(id);
    return this.detailInternal(id);
  }

  async validate(actorId: string, id: string) {
    const match = await this.load(this.prisma, id);
    if (match.resultStatus !== ResultStatus.ENTERED && match.resultStatus !== ResultStatus.DISPUTED) {
      throw conflict('errors.tournamentMatches.nothingToValidate', 'NO_RESULT_TO_VALIDATE');
    }
    if (!match.outcome) throw conflict('errors.tournamentMatches.nothingToValidate', 'NO_RESULT_TO_VALIDATE');
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, id);
      await this.finalize(tx, actorId, id);
    });
    await this.afterValidation(id);
    return this.detailInternal(id);
  }

  /** Contests a result: it stays as it is (and the winner stays through) until validated again or corrected. */
  async dispute(actorId: string, id: string, reason: string) {
    const match = await this.load(this.prisma, id);
    if (match.resultStatus !== ResultStatus.ENTERED && match.resultStatus !== ResultStatus.VALIDATED) {
      throw conflict('errors.tournamentMatches.cannotDispute', 'NO_RESULT_TO_DISPUTE');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.competitionMatch.update({ where: { id }, data: { resultStatus: ResultStatus.DISPUTED, disputeReason: reason, version: { increment: 1 } } });
      await this.record(tx, actorId, match, 'match.result.disputed', { reason });
    });
    return this.detailInternal(id);
  }

  /**
   * Validates the stored result: winner, bracket advancement and, for
   * singles actually played, the player's official match history.
   */
  private async finalize(tx: Tx, actorId: string, id: string) {
    const match = await this.load(tx, id);
    const sets = match.sets.map(toScore);
    const check = checkResult(match.round.event, match.outcome!, sets, (match.loserSide as 1 | 2 | null) ?? null);
    if (!check.ok) throw new BadRequestException({ message: t('errors.tournamentMatches.invalidScore'), code: 'SCORE_INVALID', issues: check.errors });
    const winnerId = check.winnerSide === 1 ? match.participant1Id! : match.participant2Id!;

    // Advancement: the winner fills their side of the next match. A changed
    // winner can only be swapped while that match hasn't started.
    if (match.nextMatchId) {
      const next = await tx.competitionMatch.findUniqueOrThrow({ where: { id: match.nextMatchId } });
      const sideKey = match.nextSlot === 1 ? 'participant1Id' : 'participant2Id';
      const current = next[sideKey];
      if (current !== winnerId) {
        if (current && !NOT_STARTED.includes(next.status)) throw conflict('errors.tournamentMatches.nextMatchStarted', 'NEXT_MATCH_STARTED');
        const other = match.nextSlot === 1 ? next.participant2Id : next.participant1Id;
        const status = other ? (next.scheduledAt ? M.SCHEDULED : next.status === M.POSTPONED ? M.POSTPONED : M.READY) : next.status;
        await tx.competitionMatch.update({ where: { id: next.id }, data: { [sideKey]: winnerId, status, version: { increment: 1 } } });
      }
    }

    const now = new Date();
    await tx.competitionMatch.update({
      where: { id },
      data: {
        winnerId,
        status: M.COMPLETED,
        completedAt: match.completedAt ?? now,
        resultStatus: ResultStatus.VALIDATED,
        resultValidatedById: actorId,
        resultValidatedAt: now,
        disputeReason: null,
        version: { increment: 1 },
      },
    });
    await this.linkOfficialMatch(tx, match, winnerId, check.winnerSide, sets);
    await this.record(tx, actorId, match, 'match.result.validated', { after: { winnerId, score: formatScore(sets), outcome: match.outcome } });
  }

  /**
   * Singles results feed the players' history and season ranking through a
   * linked OFFICIAL Match (walkovers aren't matches played, so they don't).
   */
  private async linkOfficialMatch(tx: Tx, match: MatchRow, winnerId: string, winnerSide: 1 | 2, sets: SetScore[]) {
    const singles = match.round.event.discipline === EventDiscipline.SINGLES;
    const existing = await tx.competitionMatch.findUniqueOrThrow({ where: { id: match.id }, select: { linkedMatchId: true } });
    if (!singles || match.outcome === MatchOutcome.WALKOVER) {
      if (existing.linkedMatchId) {
        await tx.competitionMatch.update({ where: { id: match.id }, data: { linkedMatchId: null } });
        await tx.match.delete({ where: { id: existing.linkedMatchId } });
      }
      return;
    }
    const p1 = match.participant1!;
    const p2 = match.participant2!;
    const winnerUser = winnerId === p1.id ? p1.userId : p2.userId;
    const data = {
      player1Id: p1.userId,
      player2Id: p2.userId,
      clubId: match.court?.club.id ?? match.round.competition.clubId,
      courtId: match.court?.id ?? null,
      location: match.round.competition.name,
      playedAt: match.startedAt ?? match.scheduledAt ?? new Date(),
      bestOf: match.round.event.bestOf,
      noAd: match.round.event.noAd,
      finalSet: match.round.event.finalSet,
      matchType: RecordedMatchType.OFFICIAL,
      status: match.outcome === MatchOutcome.RETIRED ? MatchStatus.UNFINISHED : MatchStatus.COMPLETED,
      winnerId: winnerUser,
      winnerSide: winnerSide === 1 ? PlayerSide.PLAYER1 : PlayerSide.PLAYER2,
      notes: `${match.round.competition.name} · ${match.round.event.name}`,
    };
    const setRows = sets.map((s, i) => ({
      setNumber: i + 1,
      player1Games: s.side1,
      player2Games: s.side2,
      isTiebreak: !s.superTiebreak && s.tiebreak1 != null,
      isSuperTiebreak: !!s.superTiebreak,
      tiebreakPlayer1Points: s.tiebreak1 ?? null,
      tiebreakPlayer2Points: s.tiebreak2 ?? null,
    }));
    if (existing.linkedMatchId) {
      await tx.matchSet.deleteMany({ where: { matchId: existing.linkedMatchId } });
      await tx.match.update({ where: { id: existing.linkedMatchId }, data: { ...data, sets: { create: setRows } } });
    } else {
      const created = await tx.match.create({ data: { ...data, sets: { create: setRows } } });
      await tx.competitionMatch.update({ where: { id: match.id }, data: { linkedMatchId: created.id } });
    }
  }

  private async afterValidation(id: string) {
    const match = await this.load(this.prisma, id);
    await this.notifyPlayers(match, 'matchResult', { score: formatScore(match.sets.map(toScore)) || 'W.O.' });
  }

  // Courts of the tournament ----------------------------------------------

  /** Chosen courts, else the venue club's courts. */
  async allowedCourtIds(competitionId: string, venueClubId: string | null): Promise<string[]> {
    const chosen = await this.prisma.competitionCourt.findMany({ where: { competitionId }, select: { courtId: true } });
    if (chosen.length) return chosen.map((c) => c.courtId);
    if (!venueClubId) return [];
    const courts = await this.prisma.court.findMany({ where: { clubId: venueClubId, archivedAt: null }, select: { id: true } });
    return courts.map((c) => c.id);
  }

  private async conflicts(match: MatchRow, courtId: string, start: Date, end: Date) {
    const players = new Set([...usersOf(match.participant1), ...usersOf(match.participant2)]);
    const [courtBlocks, bookings, competitionBlocks] = await Promise.all([
      matchBlocks(this.prisma, { courtIds: [courtId] }, start, end),
      this.prisma.booking.findMany({
        where: { courtId, status: { not: BookingStatus.CANCELLED }, startTime: { lt: end }, endTime: { gt: start } },
        select: { id: true, startTime: true, endTime: true, user: { select: { firstname: true, lastname: true } } },
      }),
      players.size ? matchBlocks(this.prisma, { competitionId: match.round.competition.id }, start, end) : Promise.resolve([]),
    ]);
    const others = competitionBlocks.filter((b) => b.matchId !== match.id);
    const entries = others.length
      ? await this.prisma.competitionParticipant.findMany({
          where: { id: { in: others.flatMap((b) => b.participantIds) } },
          select: { id: true, userId: true, partnerUserId: true, user: { select: { firstname: true, lastname: true } } },
        })
      : [];
    const byEntry = new Map(entries.map((e) => [e.id, e]));
    return [
      ...courtBlocks
        .filter((b) => b.matchId !== match.id)
        .map((b) => ({ type: 'COURT', matchId: b.matchId, label: `${b.competitionName} · ${b.eventName}`, start: b.start, end: b.end })),
      ...bookings.map((b) => ({ type: 'BOOKING', bookingId: b.id, label: `${b.user.firstname} ${b.user.lastname}`, start: b.startTime, end: b.endTime })),
      ...others.flatMap((b) => {
        const busy = b.participantIds
          .map((pid) => byEntry.get(pid))
          .filter((e): e is NonNullable<typeof e> => !!e && (players.has(e.userId) || (!!e.partnerUserId && players.has(e.partnerUserId))));
        return busy.length && overlaps(b.start, b.end, start, end)
          ? [{ type: 'PLAYER', matchId: b.matchId, label: busy.map((e) => `${e.user.firstname} ${e.user.lastname}`).join(', '), start: b.start, end: b.end }]
          : [];
      }),
    ];
  }

  // Schedule board -----------------------------------------------------------

  /**
   * One day of the tournament for the scheduling board: its courts with
   * their opening windows, the matches placed on them, what else occupies
   * them (bookings, other tournaments) and the matches still to schedule.
   */
  async scheduleDay(grants: readonly Grant[], actorId: string, competitionId: string, date: string) {
    const competition = await this.prisma.competition.findUnique({
      where: { id: competitionId },
      select: { id: true, name: true, startDate: true, endDate: true, clubId: true },
    });
    if (!competition) throw new NotFoundException(t('errors.tournaments.notFound'));
    const dayStart = new Date(`${date}T00:00:00Z`);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const courtIds = await this.allowedCourtIds(competitionId, competition.clubId);
    const [courts, blocks, bookings, matches, unscheduled] = await Promise.all([
      this.prisma.court.findMany({
        where: { id: { in: courtIds } },
        orderBy: [{ club: { name: 'asc' } }, { number: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          number: true,
          status: true,
          surface: true,
          lighting: true,
          availability: { select: { weekday: true, opensAt: true, closesAt: true } },
          club: { select: { id: true, name: true, openingHours: true } },
        },
      }),
      matchBlocks(this.prisma, { courtIds }, dayStart, dayEnd),
      this.prisma.booking.findMany({
        where: { courtId: { in: courtIds }, status: { not: BookingStatus.CANCELLED }, startTime: { lt: dayEnd }, endTime: { gt: dayStart } },
        select: { id: true, courtId: true, startTime: true, endTime: true, user: { select: { firstname: true, lastname: true } } },
      }),
      this.prisma.competitionMatch.findMany({
        where: { AND: [this.visibleWhere(grants, actorId), { round: { competitionId }, scheduledAt: { gte: dayStart, lt: dayEnd } }] },
        orderBy: { scheduledAt: 'asc' },
        select: matchSelect,
      }),
      this.prisma.competitionMatch.findMany({
        where: {
          AND: [
            this.visibleWhere(grants, actorId),
            { round: { competitionId }, scheduledAt: null, status: { notIn: [M.COMPLETED, M.BYE, M.LIVE] } },
          ],
        },
        orderBy: [{ round: { event: { tableOrder: 'asc' } } }, { round: { orderIndex: 'asc' } }, { position: 'asc' }],
        take: 200,
        select: matchSelect,
      }),
    ]);
    const days: string[] = [];
    for (let d = new Date(competition.startDate); d <= competition.endDate; d = new Date(d.getTime() + 86_400_000)) {
      days.push(d.toISOString().slice(0, 10));
    }
    return {
      competition: { id: competition.id, name: competition.name },
      date,
      days,
      courts: courts.map(({ availability, club, ...court }) => ({
        ...court,
        club: { id: club.id, name: club.name },
        windows: windowsFor(dayStart, availability, parseOpeningHours(club.openingHours)),
      })),
      matches: matches.map((m) => this.view(m)),
      // Other tournaments on these courts.
      otherMatches: blocks.filter((b) => b.competitionId !== competitionId).map((b) => ({ courtId: b.courtId, start: b.start, end: b.end, label: `${b.competitionName} · ${b.eventName}` })),
      bookings: bookings.map((b) => ({ id: b.id, courtId: b.courtId, start: b.startTime, end: b.endTime, label: `${b.user.firstname} ${b.user.lastname}` })),
      unscheduled: unscheduled.map((m) => this.view(m)),
    };
  }

  /** Courts that can be chosen for a tournament: the venue's and the host club's. */
  async courtOptions(competitionId: string) {
    const competition = await this.prisma.competition.findUnique({
      where: { id: competitionId },
      select: { clubId: true, hostOrganization: { select: { club: { select: { id: true } } } }, courts: { select: { courtId: true } } },
    });
    if (!competition) throw new NotFoundException(t('errors.tournaments.notFound'));
    const clubIds = [competition.clubId, competition.hostOrganization?.club?.id].filter((id): id is string => !!id);
    const chosen = new Set(competition.courts.map((c) => c.courtId));
    const courts = await this.prisma.court.findMany({
      where: { OR: [{ clubId: { in: clubIds }, archivedAt: null }, { id: { in: [...chosen] } }] },
      orderBy: [{ club: { name: 'asc' } }, { number: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
      select: { id: true, name: true, number: true, status: true, surface: true, club: { select: { id: true, name: true } } },
    });
    return { courts: courts.map((c) => ({ ...c, chosen: chosen.has(c.id) })), usesVenueDefault: chosen.size === 0 };
  }

  async setCourts(actorId: string, competitionId: string, courtIds: string[]) {
    const competition = await this.prisma.competition.findUnique({ where: { id: competitionId }, select: { id: true, hostOrganizationId: true } });
    if (!competition) throw new NotFoundException(t('errors.tournaments.notFound'));
    const found = await this.prisma.court.count({ where: { id: { in: courtIds } } });
    if (found !== new Set(courtIds).size) throw new NotFoundException(t('errors.courts.notFound'));
    await this.prisma.$transaction(async (tx) => {
      await tx.competitionCourt.deleteMany({ where: { competitionId } });
      await tx.competitionCourt.createMany({ data: [...new Set(courtIds)].map((courtId) => ({ competitionId, courtId })) });
      await this.audit.record(
        { actorId, action: 'tournament.courts.changed', entityType: 'Competition', entityId: competitionId, organizationId: competition.hostOrganizationId, competitionId, after: { courtIds } },
        tx,
      );
    });
    return this.courtOptions(competitionId);
  }

  // Access ----------------------------------------------------------------

  /**
   * Rows the actor may see: everything under grants holding `match.view`,
   * except that competitions where they only hold it with
   * `match.assigned_only` show only their own matches.
   */
  private visibleWhere(grants: readonly Grant[], actorId: string): Prisma.CompetitionMatchWhereInput {
    const full = grants.filter((g) => g.permissions.has('match.view') && !g.permissions.has('match.assigned_only'));
    const restricted = grants.filter((g) => g.permissions.has('match.view') && g.permissions.has('match.assigned_only'));
    if (full.some((g) => g.scope.type === RoleScope.GLOBAL)) return {};
    const ids = (list: Grant[], type: RoleScope) => list.flatMap((g) => (g.scope.type === type ? [(g.scope as { id: string }).id] : []));
    return {
      OR: [
        { round: { competitionId: { in: ids(full, RoleScope.COMPETITION) } } },
        { round: { competition: { hostOrganizationId: { in: ids(full, RoleScope.ORGANIZATION) } } } },
        { round: { competitionId: { in: ids(restricted, RoleScope.COMPETITION) } }, officialUserId: actorId },
      ],
    };
  }

  /** True when `permission` comes from a grant that doesn't limit it to assigned matches. */
  private holdsUnrestricted(grants: readonly Grant[], permission: PermissionKey, chain: Scope[]) {
    return holds(
      grants.filter((g) => !g.permissions.has('match.assigned_only')),
      permission,
      chain,
    );
  }

  private async assertMayView(grants: readonly Grant[], actorId: string, match: MatchRow) {
    const chain = await this.authz.scopeChain('match', match.id);
    if (this.holdsUnrestricted(grants, 'match.view', chain)) return;
    if (holds(grants, 'match.view', chain) && match.official?.id === actorId) return;
    throw new ForbiddenException({ message: t('errors.http.forbidden'), code: 'FORBIDDEN' });
  }

  private async assertAssigned(grants: readonly Grant[], actorId: string, match: MatchRow, permission: PermissionKey) {
    const chain = await this.authz.scopeChain('match', match.id);
    if (this.holdsUnrestricted(grants, permission, chain)) return;
    if (holds(grants, permission, chain) && match.official?.id === actorId) return;
    throw new ForbiddenException({ message: t('errors.tournamentMatches.notAssigned'), code: 'NOT_ASSIGNED' });
  }

  private assertTournamentOpen(match: MatchRow) {
    const closed: CompetitionStatus[] = [CompetitionStatus.COMPLETED, CompetitionStatus.CANCELLED];
    if (closed.includes(match.round.competition.status)) throw conflict('errors.tournaments.notEditable', 'TOURNAMENT_CLOSED');
  }

  // Helpers ---------------------------------------------------------------

  /** Row lock; with `version`, refuses a form built on an older state. */
  private async lock(tx: Tx, id: string, version?: number) {
    const [row] = await tx.$queryRaw<{ version: number }[]>`SELECT version FROM "CompetitionMatch" WHERE id = ${id} FOR UPDATE`;
    if (version !== undefined && row && row.version !== version) throw conflict('errors.tournamentMatches.stale', 'MATCH_VERSION_CONFLICT');
  }

  private async load(db: Tx | PrismaService, id: string): Promise<MatchRow> {
    const match = await db.competitionMatch.findUnique({ where: { id }, select: matchSelect });
    if (!match) throw new NotFoundException(t('errors.tournamentMatches.notFound'));
    return match;
  }

  private async detailInternal(id: string) {
    return this.view(await this.load(this.prisma, id));
  }

  private view(m: MatchRow) {
    const { participant1, participant2, round, sets, ...rest } = m;
    const duration = round.event.matchDurationMinutes;
    return {
      ...rest,
      estimatedEndAt: m.scheduledAt ? new Date(m.scheduledAt.getTime() + duration * 60_000) : null,
      side1: sideView(participant1),
      side2: sideView(participant2),
      winnerSide: m.winnerId ? (m.winnerId === m.participant1Id ? 1 : 2) : null,
      sets,
      score: formatScore(sets.map(toScore)),
      round: { number: round.orderIndex, name: round.name, rounds: round.event.drawSize ? Math.log2(round.event.drawSize) : null },
      event: round.event,
      competition: round.competition,
    };
  }

  private record(tx: Tx, actorId: string, match: MatchRow, action: string, entry: { before?: unknown; after?: unknown; reason?: string }) {
    return this.audit.record(
      {
        actorId,
        action,
        entityType: 'CompetitionMatch',
        entityId: match.id,
        organizationId: match.round.competition.hostOrganizationId,
        competitionId: match.round.competition.id,
        ...entry,
        after: { match: `${nameOf(match.participant1)} – ${nameOf(match.participant2)}`, ...(entry.after as object | undefined) },
      },
      tx,
    );
  }

  private async notifyPlayers(match: MatchRow, key: MatchNotificationKey, params: Record<string, string>) {
    const users = new Set([...usersOf(match.participant1), ...usersOf(match.participant2)]);
    const message = matchNotification(key, match.round.competition.id, match.round.competition.name, match.round.event.name, params);
    for (const userId of users) await this.notifications.notify(userId, message);
  }
}

const toScore = (s: { side1Games: number; side2Games: number; tiebreak1: number | null; tiebreak2: number | null; isSuperTiebreak: boolean }): SetScore => ({
  side1: s.side1Games,
  side2: s.side2Games,
  tiebreak1: s.tiebreak1,
  tiebreak2: s.tiebreak2,
  superTiebreak: s.isSuperTiebreak,
});
