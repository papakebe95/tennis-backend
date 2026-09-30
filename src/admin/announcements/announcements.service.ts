import { Injectable, NotFoundException } from '@nestjs/common';
import { AffiliationStatus, AnnouncementAudience, MemberStatus, OrganizationType, Prisma, RegistrationStatus } from '@prisma/client';
import { AuditService } from '../../audit/audit.service.js';
import { t } from '../../i18n/i18n.js';
import { announcement } from '../../notifications/notification-messages.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export type AnnouncementTarget =
  | { kind: 'tournament'; competitionId: string; eventId?: string | null }
  | { kind: 'club'; clubId: string }
  | { kind: 'federation'; federationId: string };

const ACTIVE_ENTRIES: RegistrationStatus[] = [RegistrationStatus.PENDING, RegistrationStatus.APPROVED, RegistrationStatus.WAITLISTED];

const listSelect = {
  id: true,
  audience: true,
  title: true,
  body: true,
  recipientCount: true,
  createdAt: true,
  event: { select: { id: true, name: true } },
  sentBy: { select: { id: true, firstname: true, lastname: true } },
} satisfies Prisma.AnnouncementSelect;

/**
 * Messages to a group of players — a tournament's entrants (or one table's),
 * a club's members, a federation's players — delivered as notifications in
 * the player app and kept as a history.
 */
@Injectable()
export class AnnouncementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** History, plus how many people each audience reaches now. */
  async list(target: AnnouncementTarget) {
    const scope = await this.resolve(target);
    const [items, reach] = await Promise.all([
      this.prisma.announcement.findMany({
        where: scope.where,
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: listSelect,
      }),
      this.reach(target),
    ]);
    return { items, reach };
  }

  async send(actorId: string, target: AnnouncementTarget, input: { title: string; body: string }) {
    const scope = await this.resolve(target);
    const userIds = await this.recipients(target);
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.announcement.create({
        data: {
          audience: scope.audience,
          competitionId: target.kind === 'tournament' ? target.competitionId : null,
          eventId: target.kind === 'tournament' ? (target.eventId ?? null) : null,
          organizationId: scope.organizationId,
          title: input.title,
          body: input.body,
          recipientCount: userIds.length,
          sentById: actorId,
        },
        select: listSelect,
      });
      await this.audit.record(
        {
          actorId,
          action: 'announcement.sent',
          entityType: 'Announcement',
          entityId: created.id,
          organizationId: scope.organizationId,
          competitionId: target.kind === 'tournament' ? target.competitionId : null,
          after: { audience: scope.audience, title: input.title, recipients: userIds.length, event: created.event?.name ?? null },
        },
        tx,
      );
      return created;
    });
    const message = announcement(scope.from, input.title, input.body, scope.route);
    for (const userId of userIds) await this.notifications.notify(userId, message);
    return row;
  }

  // Audiences --------------------------------------------------------------

  private async resolve(target: AnnouncementTarget) {
    if (target.kind === 'tournament') {
      const competition = await this.prisma.competition.findUnique({ where: { id: target.competitionId }, select: { name: true, hostOrganizationId: true } });
      if (!competition) throw new NotFoundException(t('errors.tournaments.notFound'));
      return {
        audience: AnnouncementAudience.TOURNAMENT_ENTRANTS,
        organizationId: competition.hostOrganizationId,
        from: competition.name,
        route: `/tournaments/${target.competitionId}`,
        where: { competitionId: target.competitionId } satisfies Prisma.AnnouncementWhereInput,
      };
    }
    if (target.kind === 'club') {
      const club = await this.prisma.club.findUnique({ where: { id: target.clubId }, select: { name: true, organizationId: true } });
      if (!club) throw new NotFoundException(t('errors.clubs.notFound'));
      return {
        audience: AnnouncementAudience.CLUB_MEMBERS,
        organizationId: club.organizationId,
        from: club.name,
        route: undefined,
        where: { organizationId: club.organizationId, audience: AnnouncementAudience.CLUB_MEMBERS } satisfies Prisma.AnnouncementWhereInput,
      };
    }
    const federation = await this.prisma.organization.findUnique({ where: { id: target.federationId }, select: { name: true, type: true } });
    if (!federation || federation.type !== OrganizationType.FEDERATION) {
      throw new NotFoundException(t('errors.organizations.wrongType', { type: OrganizationType.FEDERATION }));
    }
    return {
      audience: AnnouncementAudience.FEDERATION_PLAYERS,
      organizationId: target.federationId,
      from: federation.name,
      route: undefined,
      where: { organizationId: target.federationId, audience: AnnouncementAudience.FEDERATION_PLAYERS } satisfies Prisma.AnnouncementWhereInput,
    };
  }

  /** Account ids reached, once each. */
  async recipients(target: AnnouncementTarget): Promise<string[]> {
    if (target.kind === 'tournament') {
      const entries = await this.prisma.competitionParticipant.findMany({
        where: { competitionId: target.competitionId, status: { in: ACTIVE_ENTRIES }, ...(target.eventId ? { eventId: target.eventId } : {}) },
        select: { userId: true, partnerUserId: true },
      });
      return [...new Set(entries.flatMap((e) => [e.userId, ...(e.partnerUserId ? [e.partnerUserId] : [])]))];
    }
    const now = new Date();
    const members = await this.prisma.clubMember.findMany({
      where: {
        status: MemberStatus.ACTIVE,
        ...(target.kind === 'club'
          ? { clubId: target.clubId }
          : {
              // Federation players: members in good standing of affiliated clubs.
              currentMembership: { is: { expiresAt: { gte: now } } },
              club: {
                organization: {
                  status: 'ACTIVE',
                  memberships: { some: { parentOrgId: target.federationId, status: AffiliationStatus.ACTIVE } },
                },
              },
            }),
      },
      select: { userId: true },
    });
    return [...new Set(members.map((m) => m.userId))];
  }

  private async reach(target: AnnouncementTarget) {
    if (target.kind !== 'tournament') return { all: (await this.recipients(target)).length, byEvent: {} };
    const events = await this.prisma.competitionEvent.findMany({ where: { competitionId: target.competitionId }, select: { id: true } });
    const byEvent: Record<string, number> = {};
    for (const e of events) byEvent[e.id] = (await this.recipients({ ...target, eventId: e.id })).length;
    return { all: (await this.recipients({ kind: 'tournament', competitionId: target.competitionId })).length, byEvent };
  }
}
