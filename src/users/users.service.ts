import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AvailabilityStatus,
  MatchStatus,
  PlayerLevel,
  PhoneLabel,
  Prisma,
  User,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { normalizePhone } from '../common/utils/phone.js';
import { CreatePhoneDto } from './dto/phone.dto.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import {
  aggregateSeason,
  POINT_RULES,
  GUEST_MULTIPLIER,
  rankPlayers,
  TIERS,
  tierFor,
} from './ranking.js';
import { t } from '../i18n/i18n.js';

const MAX_EXTRA_PHONES = 5;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async getMeWithProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        playerProfile: true,
        phones: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!user) {
      throw new NotFoundException(t('errors.users.notFound'));
    }

    const { passwordHash: _passwordHash, playerProfile, ...safeUser } = user;
    return {
      ...safeUser,
      // Always present, so clients never juggle a missing profile.
      playerProfile: playerProfile ?? {
        level: PlayerLevel.BEGINNER,
        ntrpRating: null,
        preferredSurface: null,
        bio: null,
        avatarUrl: null,
        city: null,
        dominantHand: null,
        backhand: null,
        availabilityStatus: AvailabilityStatus.AVAILABLE,
        availabilityNote: null,
      },
    };
  }

  async updateMe(userId: string, dto: UpdateProfileDto) {
    const { firstname, lastname, ...profile } = dto;
    const profileData = {
      level: profile.level,
      ntrpRating: profile.ntrpRating,
      preferredSurface: profile.preferredSurface,
      bio: profile.bio,
      avatarUrl: profile.avatarUrl,
      city: profile.city,
      dominantHand: profile.dominantHand,
      backhand: profile.backhand,
      availabilityStatus: profile.availabilityStatus,
      availabilityNote: profile.availabilityNote,
    };
    if (profile.ntrpRating != null && (profile.ntrpRating * 2) % 1 !== 0) {
      throw new BadRequestException(t('errors.users.ntrpStep'));
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { firstname, lastname },
      }),
      this.prisma.playerProfile.upsert({
        where: { userId },
        create: {
          userId,
          ...profileData,
          level: profile.level ?? PlayerLevel.BEGINNER,
        },
        update: profileData,
      }),
    ]);
    return this.getMeWithProfile(userId);
  }

  // -- Extra phone numbers ---------------------------------------------------

  async addPhone(userId: string, dto: CreatePhoneDto) {
    const number = this.requirePhone(dto.number);
    const count = await this.prisma.userPhone.count({ where: { userId } });
    if (count >= MAX_EXTRA_PHONES) {
      throw new BadRequestException(
        t('errors.phone.max', { max: MAX_EXTRA_PHONES }),
      );
    }
    await this.assertNumberFree(number);
    await this.prisma.userPhone.create({
      data: { userId, number, label: dto.label ?? PhoneLabel.MOBILE },
    });
    return this.getMeWithProfile(userId);
  }

  async updatePhone(userId: string, phoneId: string, label: PhoneLabel) {
    const { count } = await this.prisma.userPhone.updateMany({
      where: { id: phoneId, userId },
      data: { label },
    });
    if (count === 0) throw new NotFoundException(t('errors.phone.notFound'));
    return this.getMeWithProfile(userId);
  }

  async removePhone(userId: string, phoneId: string) {
    const { count } = await this.prisma.userPhone.deleteMany({
      where: { id: phoneId, userId },
    });
    if (count === 0) throw new NotFoundException(t('errors.phone.notFound'));
    return this.getMeWithProfile(userId);
  }

  // Swaps the chosen extra number with the primary one, so no number is lost.
  async makePhonePrimary(userId: string, phoneId: string) {
    await this.prisma.$transaction(async (tx) => {
      const phone = await tx.userPhone.findFirst({
        where: { id: phoneId, userId },
      });
      if (!phone) throw new NotFoundException(t('errors.phone.notFound'));
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      await tx.userPhone.update({
        where: { id: phone.id },
        data: { number: `swap-${phone.id}` },
      });
      await tx.user.update({
        where: { id: userId },
        data: { msisdn: phone.number },
      });
      await tx.userPhone.update({
        where: { id: phone.id },
        data: { number: user.msisdn },
      });
    });
    return this.getMeWithProfile(userId);
  }

  private requirePhone(raw: string): string {
    const number = normalizePhone(raw);
    if (!number) {
      throw new BadRequestException(t('errors.phone.invalid'));
    }
    return number;
  }

  private async assertNumberFree(number: string) {
    const [asPrimary, asExtra] = await Promise.all([
      this.prisma.user.findUnique({ where: { msisdn: number } }),
      this.prisma.userPhone.findUnique({ where: { number } }),
    ]);
    if (asPrimary || asExtra) {
      throw new ConflictException(t('errors.phone.inUse'));
    }
  }

  // -- Season ranking ----------------------------------------------------------

  async ranking(userId: string, year = new Date().getFullYear()) {
    const rows = await this.prisma.match.findMany({
      where: {
        winnerSide: { not: null },
        status: { in: [MatchStatus.COMPLETED, MatchStatus.UNFINISHED] },
        playedAt: {
          gte: new Date(Date.UTC(year, 0, 1)),
          lt: new Date(Date.UTC(year + 1, 0, 1)),
        },
      },
      select: {
        player1Id: true,
        player2Id: true,
        winnerSide: true,
        matchType: true,
        playedAt: true,
      },
    });

    const season = aggregateSeason(
      rows.map((r) => ({ ...r, winnerSide: r.winnerSide! })),
    );
    const ranked = rankPlayers([...season.values()]);
    const mine = ranked.find((p) => p.userId === userId);

    const users = await this.prisma.user.findMany({
      where: { id: { in: ranked.slice(0, 5).map((p) => p.userId) } },
      select: { id: true, firstname: true, lastname: true },
    });
    const names = new Map(
      users.map((u) => [u.id, `${u.firstname} ${u.lastname}`.trim()]),
    );

    const points = mine?.points ?? 0;
    const wins = mine?.wins ?? 0;
    const losses = mine?.losses ?? 0;
    const decided = wins + losses;
    return {
      year,
      points,
      tier: tierFor(points),
      // null while the player has no decided match this year.
      rank: mine?.rank ?? null,
      totalPlayers: ranked.length,
      matches: decided,
      wins,
      losses,
      winRate: decided === 0 ? null : wins / decided,
      form: (mine?.results ?? []).slice(0, 5),
      top: ranked.slice(0, 5).map((p) => ({
        rank: p.rank,
        userId: p.userId,
        name: names.get(p.userId) ?? 'Player',
        points: p.points,
        isMe: p.userId === userId,
      })),
      // Rules shipped with the data so the app never drifts from the backend.
      rules: {
        matchTypes: (Object.keys(POINT_RULES) as (keyof typeof POINT_RULES)[]).map(
          (type) => ({ type, ...POINT_RULES[type] }),
        ),
        guestMultiplier: GUEST_MULTIPLIER,
        tiers: TIERS,
      },
    };
  }

  // Name-only player search (never email / phone). Every word must match the
  // first or last name, accent- and case-insensitively, so "aissatou dia"
  // finds "Aïssatou Diallo".
  async search(userId: string, q: string) {
    const terms = q.trim().split(/\s+/).filter(Boolean).slice(0, 3);
    if (terms.length === 0 || terms.join('').length < 2) {
      return [];
    }
    const matchesTerm = terms.map((term) => {
      const pattern = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
      return Prisma.sql`(unaccent("firstname") ILIKE unaccent(${pattern}) OR unaccent("lastname") ILIKE unaccent(${pattern}))`;
    });
    return this.prisma.$queryRaw<
      { id: string; firstname: string; lastname: string }[]
    >(Prisma.sql`
      SELECT "id", "firstname", "lastname"
      FROM "User"
      WHERE "id" <> ${userId} AND ${Prisma.join(matchesTerm, ' AND ')}
      ORDER BY "firstname" ASC, "lastname" ASC
      LIMIT 10
    `);
  }
}
