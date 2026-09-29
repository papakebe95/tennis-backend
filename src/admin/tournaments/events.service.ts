import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DrawStatus, Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service.js';
import { t } from '../../i18n/i18n.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { tableIssues, type TableIssue } from './eligibility.js';
import { isEditable } from './tournament-lifecycle.js';
import type { CreateEventDto, EventDto, NewTournamentEventDto } from './tournaments.dto.js';

type Tx = Prisma.TransactionClient;

/** Event columns written from the DTO as they are. */
const EVENT_FIELDS = [
  'name',
  'discipline',
  'gender',
  'ageMin',
  'ageMax',
  'minClassificationId',
  'maxClassificationId',
  'format',
  'maxEntries',
  'entryFee',
  'seedCount',
  'bestOf',
  'gamesPerSet',
  'finalSet',
  'noAd',
  'matchDurationMinutes',
  'qualifiesIntoEventId',
  'qualifierCount',
  'tableOrder',
] as const;

/** Changing these would invalidate a generated draw. */
const DRAW_SHAPING_FIELDS = ['discipline', 'format', 'qualifierCount', 'seedCount'] as const;

const eventData = (dto: EventDto) =>
  Object.fromEntries(EVENT_FIELDS.filter((k) => dto[k] !== undefined).map((k) => [k, dto[k]])) as Partial<
    Pick<EventDto, (typeof EVENT_FIELDS)[number]>
  >;

interface TableRow {
  id: string;
  name: string;
  tableOrder: number;
  qualifiesIntoEventId: string | null;
  qualifierCount: number;
  minClassification: { rank: number } | null;
  maxClassification: { rank: number } | null;
}

/**
 * A tournament's tables ("events"). Every change re-validates how the tables
 * chain together and refreshes the tournament summary the player app reads
 * (format, places, lowest entry fee).
 */
@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  issuesOf(events: readonly TableRow[]): TableIssue[] {
    return tableIssues(
      events.map((e) => ({
        id: e.id,
        name: e.name,
        tableOrder: e.tableOrder,
        qualifiesIntoEventId: e.qualifiesIntoEventId,
        qualifierCount: e.qualifierCount,
        strongestRank: e.maxClassification?.rank ?? null,
        weakestRank: e.minClassification?.rank ?? null,
      })),
    );
  }

  /** Events sent with a new tournament; `ref`s become real ids. */
  async createMany(tx: Tx, competitionId: string, events: readonly NewTournamentEventDto[]) {
    await this.assertClassifications(tx, events);
    const ids = new Map<string, string>();
    const created: { id: string; qualifiesIntoRef?: string }[] = [];
    for (const [index, { ref, qualifiesIntoRef, qualifiesIntoEventId: _ignored, ...dto }] of events.entries()) {
      const row = await tx.competitionEvent.create({
        data: { ...eventData(dto), tableOrder: dto.tableOrder ?? index, name: dto.name, competitionId },
      });
      if (ref) ids.set(ref, row.id);
      created.push({ id: row.id, qualifiesIntoRef });
    }
    for (const { id, qualifiesIntoRef } of created) {
      if (!qualifiesIntoRef) continue;
      const target = ids.get(qualifiesIntoRef);
      if (!target) throw this.tablesInvalid([{ code: 'TARGET_MISSING', eventId: id }]);
      await tx.competitionEvent.update({ where: { id }, data: { qualifiesIntoEventId: target } });
    }
  }

  async create(actorId: string, competitionId: string, dto: CreateEventDto) {
    const competition = await this.editableCompetition(competitionId);
    await this.assertClassifications(this.prisma, [dto]);
    const event = await this.prisma.$transaction(async (tx) => {
      const order = dto.tableOrder ?? (await tx.competitionEvent.count({ where: { competitionId } }));
      const row = await tx.competitionEvent.create({
        data: { ...eventData(dto), name: dto.name, tableOrder: order, competitionId },
      });
      await this.validateAndSync(tx, competitionId);
      await this.audit.record(
        {
          actorId,
          action: 'tournament.event.created',
          entityType: 'CompetitionEvent',
          entityId: row.id,
          organizationId: competition.hostOrganizationId,
          competitionId,
          after: row,
        },
        tx,
      );
      return row;
    });
    return event;
  }

  async update(actorId: string, eventId: string, dto: EventDto) {
    const before = await this.event(eventId);
    const competition = await this.editableCompetition(before.competitionId);
    await this.assertClassifications(this.prisma, [dto]);
    if (before.drawStatus !== DrawStatus.NOT_GENERATED) {
      const shaping = DRAW_SHAPING_FIELDS.some((k) => dto[k] !== undefined && dto[k] !== before[k]);
      if (shaping) throw new ConflictException(t('errors.tournaments.eventDrawExists'));
    }
    if (dto.discipline && dto.discipline !== before.discipline && before._count.entries > 0) {
      throw new ConflictException(t('errors.tournaments.eventHasEntries'));
    }
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.competitionEvent.update({ where: { id: eventId }, data: eventData(dto) });
      await this.validateAndSync(tx, before.competitionId);
      const { _count, ...snapshot } = before;
      await this.audit.record(
        {
          actorId,
          action: 'tournament.event.updated',
          entityType: 'CompetitionEvent',
          entityId: eventId,
          organizationId: competition.hostOrganizationId,
          competitionId: before.competitionId,
          before: snapshot,
          after,
        },
        tx,
      );
      return after;
    });
  }

  async remove(actorId: string, eventId: string) {
    const event = await this.event(eventId);
    const competition = await this.editableCompetition(event.competitionId);
    if (event._count.entries > 0) throw new ConflictException(t('errors.tournaments.eventHasEntries'));
    await this.prisma.$transaction(async (tx) => {
      // Tables it fed no longer send qualifiers anywhere.
      await tx.competitionEvent.updateMany({
        where: { qualifiesIntoEventId: eventId },
        data: { qualifiesIntoEventId: null, qualifierCount: 0 },
      });
      await tx.competitionEvent.delete({ where: { id: eventId } });
      await this.validateAndSync(tx, event.competitionId);
      const { _count, ...snapshot } = event;
      await this.audit.record(
        {
          actorId,
          action: 'tournament.event.deleted',
          entityType: 'CompetitionEvent',
          entityId: eventId,
          organizationId: competition.hostOrganizationId,
          competitionId: event.competitionId,
          before: snapshot,
        },
        tx,
      );
    });
  }

  /**
   * Rejects tables that don't chain (inside the transaction, so nothing is
   * saved), then refreshes the summary shown by the player app.
   */
  async validateAndSync(tx: Tx, competitionId: string) {
    const events = await tx.competitionEvent.findMany({
      where: { competitionId },
      orderBy: [{ tableOrder: 'asc' }, { createdAt: 'asc' }],
      include: { minClassification: { select: { rank: true } }, maxClassification: { select: { rank: true } } },
    });
    const issues = this.issuesOf(events);
    if (issues.length) throw this.tablesInvalid(issues);

    const fees = events.map((e) => e.entryFee).filter((fee): fee is Prisma.Decimal => fee !== null);
    const places = events.map((e) => e.maxEntries);
    await tx.competition.update({
      where: { id: competitionId },
      data: {
        ...(events[0] ? { format: events[0].format } : {}),
        entryFee: fees.length ? Prisma.Decimal.min(...fees) : null,
        maxParticipants: places.length && places.every((p) => p !== null) ? places.reduce((a, b) => a! + b!, 0) : null,
      },
    });
  }

  private tablesInvalid(issues: TableIssue[]) {
    return new BadRequestException({ message: t('errors.tournaments.tablesInvalid'), code: 'TABLES_INVALID', issues });
  }

  private async assertClassifications(db: Tx | PrismaService, events: readonly EventDto[]) {
    const ids = [...new Set(events.flatMap((e) => [e.minClassificationId, e.maxClassificationId]).filter((id): id is string => !!id))];
    if (!ids.length) return;
    const found = await db.classification.count({ where: { id: { in: ids } } });
    if (found !== ids.length) throw new NotFoundException(t('errors.tournaments.classificationNotFound'));
  }

  private async event(eventId: string) {
    const event = await this.prisma.competitionEvent.findUnique({
      where: { id: eventId },
      include: { _count: { select: { entries: true } } },
    });
    if (!event) throw new NotFoundException(t('errors.tournaments.eventNotFound'));
    return event;
  }

  private async editableCompetition(id: string) {
    const competition = await this.prisma.competition.findUnique({
      where: { id },
      select: { id: true, status: true, hostOrganizationId: true },
    });
    if (!competition) throw new NotFoundException(t('errors.tournaments.notFound'));
    if (!isEditable(competition.status)) throw new ConflictException(t('errors.tournaments.notEditable'));
    return competition;
  }
}
