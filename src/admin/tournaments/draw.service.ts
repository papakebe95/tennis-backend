import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CompetitionFormat,
  CompetitionMatchStatus as M,
  CompetitionStatus,
  DrawStatus,
  DrawSlotKind,
  EntryType,
  Prisma,
  RegistrationStatus,
} from '@prisma/client';
import { AuditService } from '../../audit/audit.service.js';
import { AuthzService } from '../../authz/authz.service.js';
import { holds, type Grant } from '../../authz/scope.js';
import { t } from '../../i18n/i18n.js';
import { drawNotification, type DrawNotificationKey } from '../../notifications/notification-messages.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  DrawError,
  firstRoundState,
  labelQualifiers,
  newDrawSeed,
  nextOf,
  planDraw,
  roundCount,
  roundName,
  type Placeholder,
  type SlotKind,
} from './draw-engine.js';
import { checkEntry, eventRulesSelect } from './entry-facts.js';
import type { DrawEntrantDto, GenerateDrawDto, SwapSlotsDto } from './draw.dto.js';

type Tx = Prisma.TransactionClient;

const conflict = (key: Parameters<typeof t>[0], code: string, extra: object = {}) =>
  new ConflictException({ message: t(key), code, ...extra });

/** Match states in which nobody has played yet. */
const NOT_STARTED: M[] = [M.PENDING, M.READY, M.SCHEDULED];

const entrySelect = {
  id: true,
  seed: true,
  entryType: true,
  status: true,
  sourceEvent: { select: { id: true, name: true } },
  user: {
    select: {
      id: true,
      firstname: true,
      lastname: true,
      playerProfile: { select: { avatarUrl: true, classification: { select: { code: true } } } },
    },
  },
  partner: { select: { id: true, firstname: true, lastname: true, playerProfile: { select: { classification: { select: { code: true } } } } } },
} satisfies Prisma.CompetitionParticipantSelect;

type EntryRow = Prisma.CompetitionParticipantGetPayload<{ select: typeof entrySelect }>;

const entryView = (e: EntryRow) => ({
  id: e.id,
  seed: e.seed,
  entryType: e.entryType,
  status: e.status,
  sourceEvent: e.sourceEvent,
  player: {
    id: e.user.id,
    firstname: e.user.firstname,
    lastname: e.user.lastname,
    avatarUrl: e.user.playerProfile?.avatarUrl ?? null,
    classification: e.user.playerProfile?.classification?.code ?? null,
  },
  partner: e.partner
    ? { id: e.partner.id, firstname: e.partner.firstname, lastname: e.partner.lastname, classification: e.partner.playerProfile?.classification?.code ?? null }
    : null,
});

const eventSelect = {
  id: true,
  name: true,
  competitionId: true,
  format: true,
  seedCount: true,
  drawStatus: true,
  drawSize: true,
  drawSeed: true,
  drawVersion: true,
  drawGeneratedAt: true,
  drawPublishedAt: true,
  drawLockedAt: true,
  ...eventRulesSelect,
  competition: { select: { id: true, name: true, status: true, startDate: true, hostOrganizationId: true } },
  feederEvents: { select: { id: true, name: true, qualifierCount: true }, orderBy: { tableOrder: 'asc' } },
} satisfies Prisma.CompetitionEventSelect;

type EventRow = Prisma.CompetitionEventGetPayload<{ select: typeof eventSelect }>;

/**
 * An event's single-elimination draw: its first-round places (DrawSlot) and
 * the bracket built from them (rounds and matches, with byes advanced).
 *
 * Before the draw is locked, every change rebuilds the bracket from the
 * places (nobody has played). After, changes touch only the matches involved:
 * filling a reserved place, or replacing a player before their next match.
 */
@Injectable()
export class DrawService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // Reading -------------------------------------------------------------

  async view(eventId: string) {
    const event = await this.event(eventId);
    const [slots, rounds, unplaced] = await Promise.all([
      this.prisma.drawSlot.findMany({
        where: { eventId },
        orderBy: { position: 'asc' },
        select: { id: true, position: true, kind: true, participantId: true, label: true, sourceEvent: { select: { id: true, name: true } }, filledAt: true },
      }),
      this.prisma.competitionRound.findMany({
        where: { eventId },
        orderBy: { orderIndex: 'asc' },
        select: {
          id: true,
          name: true,
          orderIndex: true,
          matches: {
            orderBy: { position: 'asc' },
            select: {
              id: true,
              position: true,
              status: true,
              participant1Id: true,
              participant2Id: true,
              winnerId: true,
              nextMatchId: true,
              nextSlot: true,
              scheduledAt: true,
            },
          },
        },
      }),
      this.prisma.competitionParticipant.count({ where: { eventId, status: RegistrationStatus.APPROVED, drawSlot: null } }),
    ]);
    const ids = new Set<string>();
    for (const s of slots) if (s.participantId) ids.add(s.participantId);
    for (const r of rounds) for (const m of r.matches) for (const id of [m.participant1Id, m.participant2Id, m.winnerId]) if (id) ids.add(id);
    const entries = await this.prisma.competitionParticipant.findMany({ where: { id: { in: [...ids] } }, select: entrySelect });

    const { competition, feederEvents, minClassification: _min, maxClassification: _max, ...rest } = event;
    return {
      event: rest,
      competition,
      feeders: feederEvents,
      slots,
      rounds,
      entries: Object.fromEntries(entries.map((e) => [e.id, entryView(e)])),
      unplacedCount: unplaced,
      suggestion: await this.suggestion(event),
    };
  }

  /** What a new draw would hold: approved entries and qualifier places still expected. */
  private async suggestion(event: EventRow) {
    const [approved, placeholders] = await Promise.all([
      this.prisma.competitionParticipant.count({ where: { eventId: event.id, status: RegistrationStatus.APPROVED } }),
      this.expectedQualifiers(event),
    ]);
    const lines = approved + placeholders.length;
    let size = 2;
    while (size < lines) size *= 2;
    return { entries: approved, qualifierPlaces: placeholders.length, seedCount: event.seedCount, size: lines >= 2 ? size : null };
  }

  /** One QUALIFIER place per qualifier a lower table still has to send. */
  private async expectedQualifiers(event: EventRow): Promise<Placeholder[]> {
    const entered = await this.prisma.competitionParticipant.groupBy({
      by: ['sourceEventId'],
      where: { eventId: event.id, status: RegistrationStatus.APPROVED, entryType: EntryType.QUALIFIER },
      _count: { _all: true },
    });
    return event.feederEvents.flatMap((feeder) => {
      const already = entered.find((e) => e.sourceEventId === feeder.id)?._count._all ?? 0;
      return Array.from({ length: Math.max(0, feeder.qualifierCount - already) }, () => ({ kind: 'QUALIFIER' as const, sourceEventId: feeder.id }));
    });
  }

  /**
   * Who can take a place: entries not in the draw yet, and the
   * players of each lower table, best finishers first.
   */
  async candidates(eventId: string) {
    const event = await this.event(eventId);
    const [unplaced, targetEntries] = await Promise.all([
      // Pending and waitlisted entries too: placing one accepts it.
      this.prisma.competitionParticipant.findMany({
        where: { eventId, status: { in: [RegistrationStatus.APPROVED, RegistrationStatus.PENDING, RegistrationStatus.WAITLISTED] }, drawSlot: null },
        orderBy: [{ status: 'asc' }, { seed: { sort: 'asc', nulls: 'last' } }, { registeredAt: 'asc' }],
        select: entrySelect,
      }),
      this.prisma.competitionParticipant.findMany({
        where: { eventId, status: { in: [RegistrationStatus.PENDING, RegistrationStatus.APPROVED, RegistrationStatus.WAITLISTED] } },
        select: { userId: true },
      }),
    ]);
    const inEvent = new Set(targetEntries.map((e) => e.userId));

    const lowerTables = [];
    for (const feeder of event.feederEvents) {
      const [entries, matches] = await Promise.all([
        this.prisma.competitionParticipant.findMany({
          where: { eventId: feeder.id, status: RegistrationStatus.APPROVED },
          select: entrySelect,
        }),
        this.prisma.competitionMatch.findMany({
          where: { round: { eventId: feeder.id } },
          select: { participant1Id: true, participant2Id: true, winnerId: true, status: true, round: { select: { orderIndex: true } }, nextMatchId: true },
        }),
      ]);
      const reached = new Map<string, number>();
      let champion: string | null = null;
      for (const m of matches) {
        for (const id of [m.participant1Id, m.participant2Id]) {
          if (id) reached.set(id, Math.max(reached.get(id) ?? 0, m.round.orderIndex));
        }
        if (!m.nextMatchId && m.status === M.COMPLETED) champion = m.winnerId;
      }
      const players = entries
        .map((e) => ({
          ...entryView(e),
          roundReached: reached.get(e.id) ?? null,
          champion: champion === e.id,
          alreadyInEvent: inEvent.has(e.user.id),
        }))
        .sort((a, b) => Number(b.champion) - Number(a.champion) || (b.roundReached ?? 0) - (a.roundReached ?? 0) || (a.seed ?? 99) - (b.seed ?? 99));
      lowerTables.push({ event: feeder, rounds: matches.length ? Math.max(...matches.map((m) => m.round.orderIndex)) : null, players });
    }
    return { unplaced: unplaced.map(entryView), lowerTables };
  }

  // Generating ---------------------------------------------------------

  async generate(actorId: string, eventId: string, dto: GenerateDrawDto) {
    const event = await this.event(eventId);
    if (event.format !== CompetitionFormat.SINGLE_ELIMINATION) throw conflict('errors.draws.formatUnsupported', 'DRAW_FORMAT_UNSUPPORTED');
    this.assertBeforePlay(event);
    if (event.drawStatus !== DrawStatus.NOT_GENERATED && event.drawStatus !== DrawStatus.DRAFT) {
      throw conflict('errors.draws.alreadyPublished', 'DRAW_PUBLISHED');
    }

    const entries = await this.prisma.competitionParticipant.findMany({
      where: { eventId, status: RegistrationStatus.APPROVED },
      select: { id: true, seed: true },
    });
    const expected = await this.expectedQualifiers(event);
    const qualifierCount = dto.qualifierPlaces ?? expected.length;
    const placeholders: Placeholder[] = [
      ...Array.from({ length: qualifierCount }, (_, i) => expected[i] ?? { kind: 'QUALIFIER' as const, sourceEventId: null }),
      ...Array.from({ length: dto.emptyPlaces ?? 0 }, () => ({ kind: 'EMPTY' as const })),
    ];
    const seed = newDrawSeed();
    const seedCount = dto.seedCount ?? event.seedCount;
    let plan;
    try {
      plan = planDraw({
        entries: entries.map((e) => ({ participantId: e.id, seed: e.seed })),
        placeholders,
        seedCount,
        seed,
        size: dto.size,
      });
    } catch (error) {
      if (error instanceof DrawError) {
        throw new BadRequestException({ message: t(`errors.draws.${error.code === 'TOO_FEW' ? 'tooFew' : error.code === 'TOO_MANY' ? 'tooMany' : 'sizeTooSmall'}`), code: `DRAW_${error.code}` });
      }
      throw error;
    }

    await this.prisma.$transaction(async (tx) => {
      await this.lockEvent(tx, eventId, event.drawVersion);
      await tx.competitionRound.deleteMany({ where: { eventId } });
      await tx.drawSlot.deleteMany({ where: { eventId } });
      await tx.drawSlot.createMany({
        data: plan.map((s) => ({ eventId, position: s.position, kind: s.kind, participantId: s.participantId, label: s.label, sourceEventId: s.sourceEventId })),
      });
      await this.writeBracket(tx, event, plan);
      await tx.competitionEvent.update({
        where: { id: eventId },
        data: {
          drawStatus: DrawStatus.DRAFT,
          drawSize: plan.length,
          drawSeed: seed,
          drawGeneratedAt: new Date(),
          drawPublishedAt: null,
          drawLockedAt: null,
          drawVersion: { increment: 1 },
        },
      });
      await this.record(tx, actorId, event, 'draw.generated', {
        after: {
          size: plan.length,
          seed,
          seedCount,
          entries: entries.length,
          byes: plan.filter((s) => s.kind === 'BYE').length,
          qualifierPlaces: qualifierCount,
          emptyPlaces: dto.emptyPlaces ?? 0,
        },
      });
    });
    return this.view(eventId);
  }

  async reset(actorId: string, eventId: string) {
    const event = await this.event(eventId);
    if (event.drawStatus === DrawStatus.NOT_GENERATED) return this.view(eventId);
    if (event.drawStatus === DrawStatus.LOCKED) throw conflict('errors.draws.locked', 'DRAW_LOCKED');
    await this.assertNothingPlayed(eventId);
    await this.prisma.$transaction(async (tx) => {
      await this.lockEvent(tx, eventId, event.drawVersion);
      await tx.competitionRound.deleteMany({ where: { eventId } });
      await tx.drawSlot.deleteMany({ where: { eventId } });
      await tx.competitionEvent.update({
        where: { id: eventId },
        data: { drawStatus: DrawStatus.NOT_GENERATED, drawSize: null, drawSeed: null, drawGeneratedAt: null, drawPublishedAt: null, drawVersion: { increment: 1 } },
      });
      await this.record(tx, actorId, event, 'draw.reset', { before: { status: event.drawStatus, size: event.drawSize, seed: event.drawSeed } });
    });
    return this.view(eventId);
  }

  /** Exchange two first-round places (drag and drop). Seeds follow their players. */
  async swap(actorId: string, eventId: string, dto: SwapSlotsDto) {
    const event = await this.event(eventId);
    if (event.drawStatus !== DrawStatus.DRAFT && event.drawStatus !== DrawStatus.PUBLISHED) {
      throw conflict(event.drawStatus === DrawStatus.LOCKED ? 'errors.draws.locked' : 'errors.draws.notGenerated', event.drawStatus === DrawStatus.LOCKED ? 'DRAW_LOCKED' : 'DRAW_NOT_GENERATED');
    }
    if (dto.a === dto.b) return this.view(eventId);
    await this.prisma.$transaction(async (tx) => {
      await this.lockEvent(tx, eventId, dto.version);
      const slots = await tx.drawSlot.findMany({ where: { eventId }, orderBy: { position: 'asc' } });
      const a = slots.find((s) => s.position === dto.a);
      const b = slots.find((s) => s.position === dto.b);
      if (!a || !b) throw new NotFoundException(t('errors.draws.slotNotFound'));
      const content = (s: typeof a) => ({ kind: s.kind, participantId: s.participantId, label: s.label, sourceEventId: s.sourceEventId, filledAt: s.filledAt, filledById: s.filledById });
      const swapped = slots.map((s) => (s.id === a.id ? { ...s, ...content(b) } : s.id === b.id ? { ...s, ...content(a) } : s));
      const relabelled = labelQualifiers(swapped);
      // Delete and recreate: participantId is unique and a place holds a
      // participant exactly when it is an entry, so in-place updates clash.
      await tx.competitionRound.deleteMany({ where: { eventId } });
      await tx.drawSlot.deleteMany({ where: { eventId } });
      await tx.drawSlot.createMany({
        data: relabelled.map(({ id: _id, ...s }) => s),
      });
      await this.writeBracket(tx, event, relabelled);
      await tx.competitionEvent.update({ where: { id: eventId }, data: { drawVersion: { increment: 1 } } });
      await this.record(tx, actorId, event, 'draw.slots.swapped', {
        before: { [dto.a]: a.participantId ?? a.kind, [dto.b]: b.participantId ?? b.kind },
        after: { [dto.a]: b.participantId ?? b.kind, [dto.b]: a.participantId ?? a.kind },
      });
    });
    return this.view(eventId);
  }

  async publish(actorId: string, eventId: string) {
    const event = await this.event(eventId);
    if (event.drawStatus !== DrawStatus.DRAFT) throw conflict('errors.draws.notDraft', 'DRAW_NOT_DRAFT');
    await this.prisma.$transaction(async (tx) => {
      await this.lockEvent(tx, eventId, event.drawVersion);
      await tx.competitionEvent.update({
        where: { id: eventId },
        data: { drawStatus: DrawStatus.PUBLISHED, drawPublishedAt: new Date(), drawVersion: { increment: 1 } },
      });
      await this.record(tx, actorId, event, 'draw.published', { after: { size: event.drawSize, seed: event.drawSeed } });
    });
    const placed = await this.prisma.drawSlot.findMany({ where: { eventId, participantId: { not: null } }, select: { participantId: true } });
    await this.notify(placed.map((p) => p.participantId!), 'drawPublished', event);
    return this.view(eventId);
  }

  async lock(actorId: string, eventId: string) {
    const event = await this.event(eventId);
    if (event.drawStatus !== DrawStatus.PUBLISHED) throw conflict('errors.draws.notPublished', 'DRAW_NOT_PUBLISHED');
    await this.prisma.$transaction(async (tx) => {
      await this.lockEvent(tx, eventId, event.drawVersion);
      await tx.competitionEvent.update({
        where: { id: eventId },
        data: { drawStatus: DrawStatus.LOCKED, drawLockedAt: new Date(), drawVersion: { increment: 1 } },
      });
      await this.record(tx, actorId, event, 'draw.locked', {});
    });
    return this.view(eventId);
  }

  // Filling and replacing ----------------------------------------------

  /**
   * Puts a player on a reserved place (qualifier or empty). Possible at any
   * time while that place's first match hasn't been played; on a locked
   * draw it takes `draw.modify_locked` and a reason.
   */
  async fill(grants: readonly Grant[], actorId: string, eventId: string, position: number, dto: DrawEntrantDto) {
    const event = await this.event(eventId);
    await this.assertMayChange(grants, event, dto.reason);
    const slot = await this.prisma.drawSlot.findUnique({ where: { eventId_position: { eventId, position } } });
    if (!slot) throw new NotFoundException(t('errors.draws.slotNotFound'));
    if (slot.kind !== DrawSlotKind.QUALIFIER && slot.kind !== DrawSlotKind.EMPTY) throw conflict('errors.draws.slotNotOpen', 'SLOT_NOT_OPEN');

    const newcomerId = await this.prisma.$transaction(async (tx) => {
      await this.lockEvent(tx, eventId, dto.version);
      const match = await this.firstRoundMatch(tx, eventId, position);
      if (match && !NOT_STARTED.includes(match.status)) throw conflict('errors.draws.matchStarted', 'MATCH_STARTED');
      const newcomer = await this.admit(tx, actorId, event, dto, slot.kind === DrawSlotKind.QUALIFIER ? EntryType.QUALIFIER : EntryType.DIRECT, slot.sourceEventId);
      await tx.drawSlot.update({
        where: { id: slot.id },
        data: { kind: DrawSlotKind.ENTRY, participantId: newcomer.id, filledAt: new Date(), filledById: actorId },
      });
      if (match) await this.refreshFirstRound(tx, eventId, match.id, position);
      await tx.competitionEvent.update({ where: { id: eventId }, data: { drawVersion: { increment: 1 } } });
      await this.record(tx, actorId, event, 'draw.slot.filled', {
        before: { position, kind: slot.kind, label: slot.label },
        after: { position, participantId: newcomer.id, entryType: newcomer.entryType },
        reason: dto.reason,
      });
      return newcomer.id;
    });
    await this.notify([newcomerId], 'drawPlaced', event);
    await this.notifyOpponent(eventId, newcomerId, event);
    return this.view(eventId);
  }

  /**
   * Replaces the player on a place (withdrawal, injury, lucky loser). Allowed
   * until the player's next match starts. A player who hasn't played yet is
   * replaced on the draw itself; one who already won a match is replaced
   * only in the match they are due to play, and keeps their results.
   */
  async replace(grants: readonly Grant[], actorId: string, eventId: string, position: number, dto: DrawEntrantDto) {
    const event = await this.event(eventId);
    if (!dto.reason?.trim()) throw new BadRequestException({ message: t('errors.tournaments.reasonRequired'), code: 'REASON_REQUIRED' });
    await this.assertMayChange(grants, event, dto.reason);
    const slot = await this.prisma.drawSlot.findUnique({ where: { eventId_position: { eventId, position } } });
    if (!slot) throw new NotFoundException(t('errors.draws.slotNotFound'));
    if (slot.kind !== DrawSlotKind.ENTRY || !slot.participantId) throw conflict('errors.draws.slotNotEntry', 'SLOT_NOT_ENTRY');
    const outgoingId = slot.participantId;

    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockEvent(tx, eventId, dto.version);
      const matches = await tx.competitionMatch.findMany({
        where: { round: { eventId }, OR: [{ participant1Id: outgoingId }, { participant2Id: outgoingId }] },
        include: { round: { select: { orderIndex: true } } },
      });
      const current = matches.sort((a, b) => b.round.orderIndex - a.round.orderIndex)[0];
      if (current && !NOT_STARTED.includes(current.status) && current.status !== M.BYE) {
        const lost = current.status === M.COMPLETED && current.winnerId !== outgoingId;
        throw conflict(lost ? 'errors.draws.playerEliminated' : 'errors.draws.matchStarted', lost ? 'PLAYER_ELIMINATED' : 'MATCH_STARTED');
      }
      const played = matches.filter((m) => m.status === M.COMPLETED);
      const newcomer = await this.admit(tx, actorId, event, dto, EntryType.ALTERNATE, null, outgoingId);

      await tx.competitionParticipant.update({
        where: { id: outgoingId },
        data: { status: RegistrationStatus.WITHDRAWN, rejectionReason: dto.reason!.trim(), decidedAt: new Date(), decidedById: actorId, seed: null },
      });
      const swap = (id: string | null) => (id === outgoingId ? newcomer.id : id);
      const touched = played.length === 0 ? matches : current ? [current] : [];
      if (played.length === 0) {
        await tx.drawSlot.update({ where: { id: slot.id }, data: { participantId: newcomer.id, filledAt: new Date(), filledById: actorId } });
      }
      for (const m of touched) {
        await tx.competitionMatch.update({
          where: { id: m.id },
          data: {
            participant1Id: swap(m.participant1Id),
            participant2Id: swap(m.participant2Id),
            ...(played.length === 0 ? { winnerId: swap(m.winnerId) } : {}),
          },
        });
      }
      await tx.competitionEvent.update({ where: { id: eventId }, data: { drawVersion: { increment: 1 } } });
      await this.record(tx, actorId, event, 'draw.player.replaced', {
        before: { position, participantId: outgoingId },
        after: { position, participantId: newcomer.id, entryType: newcomer.entryType, inDrawPlace: played.length === 0, matchId: current?.id ?? null },
        reason: dto.reason,
      });
      return { newcomerId: newcomer.id };
    });

    await this.notify([outgoingId], 'drawReplacedOut', event, dto.reason);
    await this.notify([result.newcomerId], 'drawPlaced', event);
    await this.notifyOpponent(eventId, result.newcomerId, event);
    return this.view(eventId);
  }

  // Bracket building -----------------------------------------------------

  /**
   * Writes every round and match of a fresh bracket from the first-round
   * places: byes are decided and their winners already placed in round 2.
   */
  private async writeBracket(tx: Tx, event: EventRow, slots: readonly { position: number; kind: SlotKind; participantId: string | null }[]) {
    const size = slots.length;
    const rounds = roundCount(size);
    const roundIds = Array.from({ length: rounds + 1 }, () => randomUUID());
    const matchIds = Array.from({ length: rounds + 1 }, (_, r) => Array.from({ length: r === 0 ? 0 : size / 2 ** r }, () => randomUUID()));

    type Row = Prisma.CompetitionMatchCreateManyInput;
    const rows: Row[][] = [[]];
    for (let r = 1; r <= rounds; r++) {
      rows.push(
        matchIds[r].map((id, p) => ({
          id,
          roundId: roundIds[r],
          position: p,
          status: M.PENDING,
          nextMatchId: r < rounds ? matchIds[r + 1][nextOf(p).position] : null,
          nextSlot: r < rounds ? nextOf(p).slot : null,
        })),
      );
    }
    rows[1].forEach((row, p) => {
      const [a, b] = [slots[2 * p], slots[2 * p + 1]];
      const state = firstRoundState(a, b);
      Object.assign(row, { participant1Id: a.participantId, participant2Id: b.participantId, status: state.status, winnerId: state.winnerId });
      if (state.winnerId && rounds > 1) {
        const next = rows[2][nextOf(p).position];
        Object.assign(next, nextOf(p).slot === 1 ? { participant1Id: state.winnerId } : { participant2Id: state.winnerId });
      }
    });
    if (rounds > 1) for (const row of rows[2]) if (row.participant1Id && row.participant2Id) row.status = M.READY;

    await tx.competitionRound.createMany({
      data: Array.from({ length: rounds }, (_, i) => ({
        id: roundIds[i + 1],
        competitionId: event.competitionId,
        eventId: event.id,
        orderIndex: i + 1,
        name: roundName(i + 1, rounds),
      })),
    });
    // Final first: earlier matches point at later ones.
    for (let r = rounds; r >= 1; r--) await tx.competitionMatch.createMany({ data: rows[r] });
  }

  /** Recomputes a first-round match after one of its places changed. */
  private async refreshFirstRound(tx: Tx, eventId: string, matchId: string, position: number) {
    const base = position - (position % 2);
    const [a, b] = await Promise.all([
      tx.drawSlot.findUniqueOrThrow({ where: { eventId_position: { eventId, position: base } } }),
      tx.drawSlot.findUniqueOrThrow({ where: { eventId_position: { eventId, position: base + 1 } } }),
    ]);
    const state = firstRoundState(a, b);
    const match = await tx.competitionMatch.update({
      where: { id: matchId },
      data: { participant1Id: a.participantId, participant2Id: b.participantId, status: state.status, winnerId: state.winnerId },
    });
    if (state.winnerId && match.nextMatchId) await this.advance(tx, match.nextMatchId, match.nextSlot!, state.winnerId);
  }

  private async advance(tx: Tx, matchId: string, side: number, participantId: string) {
    const next = await tx.competitionMatch.update({
      where: { id: matchId },
      data: side === 1 ? { participant1Id: participantId } : { participant2Id: participantId },
    });
    if (next.participant1Id && next.participant2Id && next.status === M.PENDING) {
      await tx.competitionMatch.update({ where: { id: matchId }, data: { status: M.READY } });
    }
  }

  private firstRoundMatch(tx: Tx, eventId: string, position: number) {
    return tx.competitionMatch.findFirst({ where: { round: { eventId, orderIndex: 1 }, position: Math.floor(position / 2) } });
  }

  // Helpers ---------------------------------------------------------------

  /**
   * The entry taking a place: an approved entry not yet in the draw, or a
   * player entered on the spot (qualifier from a lower table, lucky loser,
   * alternate…), with the usual eligibility check and override.
   */
  private async admit(
    tx: Tx,
    actorId: string,
    event: EventRow,
    dto: DrawEntrantDto,
    defaultType: EntryType,
    defaultSource: string | null,
    excludeId?: string,
  ) {
    if (dto.participantId) {
      const entry = await tx.competitionParticipant.findFirst({
        where: { id: dto.participantId, eventId: event.id, status: RegistrationStatus.APPROVED, drawSlot: null },
      });
      if (!entry || (excludeId && entry.id === excludeId)) throw conflict('errors.draws.entryNotAvailable', 'ENTRY_NOT_AVAILABLE');
      return entry;
    }
    if (!dto.userId) throw new BadRequestException(t('errors.draws.entrantRequired'));

    const entryType = dto.entryType ?? defaultType;
    const sourceEventId = entryType === EntryType.QUALIFIER || entryType === EntryType.LUCKY_LOSER ? (dto.sourceEventId ?? defaultSource) : null;
    if (sourceEventId && !event.feederEvents.some((f) => f.id === sourceEventId)) {
      throw new BadRequestException(t('errors.tournaments.qualifierSourceInvalid'));
    }
    const existing = await tx.competitionParticipant.findUnique({
      where: { eventId_userId: { eventId: event.id, userId: dto.userId } },
      include: { drawSlot: { select: { id: true } } },
    });
    if (existing && (existing.drawSlot || existing.id === excludeId)) throw conflict('errors.draws.alreadyInDraw', 'ALREADY_IN_DRAW');
    const partnerIds = dto.partnerUserId ? [dto.partnerUserId] : [];
    const issues = await checkEntry(tx, event, [dto.userId, ...partnerIds], event.competition.startDate, entryType);
    const override = dto.overrideReason?.trim() || null;
    if (issues.length && !override) throw conflict('errors.tournaments.notEligible', 'NOT_ELIGIBLE', { issues });

    const data = {
      status: RegistrationStatus.APPROVED,
      entryType,
      sourceEventId,
      partnerUserId: dto.partnerUserId ?? null,
      decidedAt: new Date(),
      decidedById: actorId,
      rejectionReason: null,
      seed: null,
      eligibility: { issues, override: issues.length ? override : null, checkedAt: new Date().toISOString() },
    };
    const entry = await tx.competitionParticipant.upsert({
      where: { eventId_userId: { eventId: event.id, userId: dto.userId } },
      update: data,
      create: { ...data, competitionId: event.competitionId, eventId: event.id, userId: dto.userId },
    });
    await this.audit.record(
      {
        actorId,
        action: 'registration.created',
        entityType: 'CompetitionParticipant',
        entityId: entry.id,
        organizationId: event.competition.hostOrganizationId,
        competitionId: event.competitionId,
        after: { event: event.name, userId: dto.userId, status: entry.status, entryType, viaDraw: true, eligibility: data.eligibility },
        reason: override ?? undefined,
      },
      tx,
    );
    return entry;
  }

  /** Changing a locked draw takes `draw.modify_locked` and a reason. */
  private async assertMayChange(grants: readonly Grant[], event: EventRow, reason?: string) {
    if (event.drawStatus === DrawStatus.NOT_GENERATED) throw conflict('errors.draws.notGenerated', 'DRAW_NOT_GENERATED');
    const status = event.competition.status;
    if (status === CompetitionStatus.COMPLETED || status === CompetitionStatus.CANCELLED) {
      throw conflict('errors.tournaments.notEditable', 'TOURNAMENT_CLOSED');
    }
    if (event.drawStatus !== DrawStatus.LOCKED) return;
    if (!holds(grants, 'draw.modify_locked', await this.authz.scopeChain('event', event.id))) {
      throw new ForbiddenException({ message: t('errors.draws.lockedForbidden'), code: 'DRAW_LOCKED' });
    }
    if (!reason?.trim()) throw new BadRequestException({ message: t('errors.tournaments.reasonRequired'), code: 'REASON_REQUIRED' });
  }

  private assertBeforePlay(event: EventRow) {
    const open: CompetitionStatus[] = [CompetitionStatus.DRAFT, CompetitionStatus.REGISTRATION_OPEN, CompetitionStatus.REGISTRATION_CLOSED];
    if (!open.includes(event.competition.status)) throw conflict('errors.draws.playStarted', 'PLAY_STARTED');
  }

  private async assertNothingPlayed(eventId: string) {
    const played = await this.prisma.competitionMatch.count({
      where: { round: { eventId }, status: { in: [M.LIVE, M.COMPLETED] } },
    });
    if (played) throw conflict('errors.draws.matchStarted', 'MATCH_STARTED');
  }

  /**
   * Serializes draw changes of one event. With `version`, also refuses a
   * change made from a stale screen (someone else changed the draw since).
   */
  private async lockEvent(tx: Tx, eventId: string, version?: number) {
    const [row] = await tx.$queryRaw<{ drawVersion: number }[]>`SELECT "drawVersion" FROM "CompetitionEvent" WHERE id = ${eventId} FOR UPDATE`;
    if (version !== undefined && row && row.drawVersion !== version) {
      throw conflict('errors.draws.stale', 'DRAW_VERSION_CONFLICT');
    }
  }

  private record(tx: Tx, actorId: string, event: EventRow, action: string, entry: { before?: unknown; after?: unknown; reason?: string }) {
    return this.audit.record(
      {
        actorId,
        action,
        entityType: 'CompetitionEvent',
        entityId: event.id,
        organizationId: event.competition.hostOrganizationId,
        competitionId: event.competitionId,
        ...entry,
      },
      tx,
    );
  }

  private async event(eventId: string): Promise<EventRow> {
    const event = await this.prisma.competitionEvent.findUnique({ where: { id: eventId }, select: eventSelect });
    if (!event) throw new NotFoundException(t('errors.tournaments.eventNotFound'));
    return event;
  }

  /** Tells the players (and partners) of these entries. */
  private async notify(entryIds: string[], key: DrawNotificationKey, event: EventRow, reason?: string) {
    if (!entryIds.length) return;
    const entries = await this.prisma.competitionParticipant.findMany({ where: { id: { in: entryIds } }, select: { userId: true, partnerUserId: true } });
    const message = drawNotification(key, event.competitionId, event.competition.name, event.name, reason);
    for (const userId of new Set(entries.flatMap((e) => [e.userId, e.partnerUserId]).filter((id): id is string => !!id))) {
      await this.notifications.notify(userId, message);
    }
  }

  /** The newcomer's next opponent, if known, learns who they now face. */
  private async notifyOpponent(eventId: string, newcomerId: string, event: EventRow) {
    const match = await this.prisma.competitionMatch.findFirst({
      where: { round: { eventId }, status: { in: NOT_STARTED }, OR: [{ participant1Id: newcomerId }, { participant2Id: newcomerId }] },
      orderBy: { round: { orderIndex: 'desc' } },
    });
    const opponent = match && (match.participant1Id === newcomerId ? match.participant2Id : match.participant1Id);
    if (opponent) await this.notify([opponent], 'drawOpponentChanged', event);
  }
}
