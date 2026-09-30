import { Injectable, NotFoundException } from '@nestjs/common';
import { AffiliationStatus, MemberStatus, OrganizationType, RecordedMatchType } from '@prisma/client';
import { csvDocument } from '../../common/csv.js';
import { t } from '../../i18n/i18n.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { aggregateSeason, rankPlayers } from '../../users/ranking.js';

export interface RankingQuery {
  season: number;
  q?: string;
  page: number;
  pageSize: number;
}

/**
 * A federation's ranking: its players (members in good standing of
 * affiliated clubs) ordered by season points from OFFICIAL matches, i.e.
 * tournament results. Same points as the app's season ranking.
 */
@Injectable()
export class RankingsService {
  constructor(private readonly prisma: PrismaService) {}

  async federation(federationId: string, query: RankingQuery) {
    const federation = await this.prisma.organization.findUnique({ where: { id: federationId }, select: { type: true } });
    if (!federation || federation.type !== OrganizationType.FEDERATION) {
      throw new NotFoundException(t('errors.organizations.wrongType', { type: OrganizationType.FEDERATION }));
    }
    const now = new Date();
    const players = await this.prisma.user.findMany({
      where: {
        clubMemberships: {
          some: {
            status: MemberStatus.ACTIVE,
            currentMembership: { is: { expiresAt: { gte: now } } },
            club: { organization: { status: 'ACTIVE', memberships: { some: { parentOrgId: federationId, status: AffiliationStatus.ACTIVE } } } },
          },
        },
      },
      select: {
        id: true,
        firstname: true,
        lastname: true,
        playerProfile: { select: { avatarUrl: true, gender: true, classification: { select: { code: true } } } },
        clubMemberships: { where: { status: MemberStatus.ACTIVE }, select: { club: { select: { name: true } } } },
      },
    });
    const ids = players.map((p) => p.id);
    const seasonStart = new Date(Date.UTC(query.season, 0, 1));
    const seasonEnd = new Date(Date.UTC(query.season + 1, 0, 1));
    const matches = await this.prisma.match.findMany({
      where: {
        matchType: RecordedMatchType.OFFICIAL,
        winnerSide: { not: null },
        playedAt: { gte: seasonStart, lt: seasonEnd },
        OR: [{ player1Id: { in: ids } }, { player2Id: { in: ids } }],
      },
      select: { player1Id: true, player2Id: true, winnerSide: true, matchType: true, playedAt: true },
    });
    const season = aggregateSeason(matches.map((m) => ({ ...m, winnerSide: m.winnerSide! })));
    const ranked = rankPlayers(ids.map((id) => season.get(id) ?? { userId: id, points: 0, wins: 0, losses: 0, results: [] }));
    const byId = new Map(players.map((p) => [p.id, p]));
    const q = query.q?.trim().toLowerCase();
    const rows = ranked
      .map((r) => {
        const p = byId.get(r.userId)!;
        return {
          rank: r.rank,
          userId: r.userId,
          firstname: p.firstname,
          lastname: p.lastname,
          avatarUrl: p.playerProfile?.avatarUrl ?? null,
          gender: p.playerProfile?.gender ?? null,
          classification: p.playerProfile?.classification?.code ?? null,
          clubs: [...new Set(p.clubMemberships.map((m) => m.club.name))],
          points: r.points,
          wins: r.wins,
          losses: r.losses,
          form: r.results.slice(0, 5),
        };
      })
      .filter((r) => !q || `${r.firstname} ${r.lastname}`.toLowerCase().includes(q));
    const start = (query.page - 1) * query.pageSize;
    return { items: rows.slice(start, start + query.pageSize), total: rows.length, page: query.page, pageSize: query.pageSize, season: query.season };
  }

  async federationCsv(federationId: string, season: number) {
    const all = await this.federation(federationId, { season, page: 1, pageSize: 100_000 });
    return csvDocument(
      ['rank', 'player', 'classification', 'clubs', 'points', 'wins', 'losses'],
      all.items.map((r) => [r.rank, `${r.firstname} ${r.lastname}`, r.classification ?? 'NC', r.clubs.join(' / '), r.points, r.wins, r.losses]),
    );
  }
}
