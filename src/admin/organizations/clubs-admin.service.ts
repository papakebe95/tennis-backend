import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { BookingStatus, CourtStatus, Prisma } from '@prisma/client';
import { MediaService } from '../../uploads/media.service.js';
import { AuditService } from '../../audit/audit.service.js';
import {
  HoursError,
  parseOpeningHours,
  toStoredHours,
  validateWindows,
  WEEKDAYS,
  type WeeklyHours,
} from '../../clubs/opening-hours.js';
import { currentLang, DEFAULT_LANG, t, type MessageKey } from '../../i18n/i18n.js';
import { localize } from '../../i18n/localize.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  socialLinksJson,
  type CourtAvailabilityDto,
  type CourtDto,
  type CreateCourtDto,
  type SetCourtStatusDto,
  type UpdateClubDto,
} from './organizations.dto.js';
import { pick } from './organizations.service.js';

const hoursError = (error: unknown) =>
  error instanceof HoursError ? new BadRequestException(t(`errors.hours.${error.reason}` as MessageKey)) : error;

const courtSelect = {
  id: true,
  name: true,
  number: true,
  surface: true,
  indoor: true,
  lighting: true,
  status: true,
  archivedAt: true,
  pricePerHour: true,
  photos: true,
  createdAt: true,
  availability: { select: { weekday: true, opensAt: true, closesAt: true }, orderBy: [{ weekday: 'asc' }, { opensAt: 'asc' }] },
} satisfies Prisma.CourtSelect;

/** Club profile and courts, for the club's administrators. */
@Injectable()
export class ClubsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly media: MediaService,
  ) {}

  async profile(clubId: string) {
    const club = await this.prisma.club.findUnique({
      where: { id: clubId },
      include: {
        city: { select: { id: true, name: true, translations: true, country: { select: { id: true, name: true, translations: true } } } },
        organization: {
          select: {
            id: true,
            status: true,
            website: true,
            socialLinks: true,
            memberships: {
              orderBy: { requestedAt: 'desc' },
              select: {
                id: true,
                status: true,
                requestedAt: true,
                validatedAt: true,
                reason: true,
                parent: { select: { id: true, name: true, logoUrl: true } },
              },
            },
          },
        },
        _count: { select: { courts: { where: { archivedAt: null } } } },
      },
    });
    if (!club) throw new NotFoundException(t('errors.clubs.notFound'));
    const { city, organization, _count, openingHours, translations, ...rest } = club;
    const week = parseOpeningHours(openingHours);
    return {
      // Text in the reader's language (translations overlay the columns).
      ...localize({ ...rest, translations }),
      city: localize(city).name,
      cityId: city.id,
      country: localize(city.country).name,
      countryId: city.country.id,
      organizationId: organization.id,
      status: organization.status,
      website: organization.website,
      socialLinks: organization.socialLinks,
      affiliations: organization.memberships,
      openingHours: week ? toStoredHours(week) : null,
      courtsCount: _count.courts,
    };
  }

  async update(actorId: string, clubId: string, dto: UpdateClubDto) {
    const club = await this.prisma.club.findUnique({ where: { id: clubId }, include: { organization: true } });
    if (!club) throw new NotFoundException(t('errors.clubs.notFound'));
    const kept = <T>(value: T | undefined, current: T) => (value === undefined ? current : value);
    const imagesBefore = [club.logoUrl, club.bannerUrl, ...club.photos, club.organization.logoUrl];
    const imagesAfter = [kept(dto.logoUrl, club.logoUrl), kept(dto.bannerUrl, club.bannerUrl), ...kept(dto.photos, club.photos), kept(dto.logoUrl, club.organization.logoUrl)];
    this.media.assertOwn(imagesBefore, imagesAfter);
    if (dto.cityId && !(await this.prisma.city.findUnique({ where: { id: dto.cityId } }))) {
      throw new NotFoundException(t('errors.accessRequests.cityNotFound'));
    }
    let openingHours: Prisma.InputJsonValue | undefined;
    if (dto.openingHours) {
      try {
        const week = Object.fromEntries(
          WEEKDAYS.map((day) => [
            day,
            validateWindows(
              (dto.openingHours?.[day] ?? []).map((range) => {
                const [opensAt = '', closesAt = ''] = String(range).split('-');
                return { opensAt: opensAt.trim(), closesAt: closesAt.trim() };
              }),
            ),
          ]),
        ) as WeeklyHours;
        openingHours = toStoredHours(week);
      } catch (error) {
        throw hoursError(error);
      }
    }

    // The description is translated: an edit made in French updates the
    // French text and leaves the English column alone (and vice versa).
    const lang = currentLang();
    const translations = { ...(club.translations as Record<string, Record<string, unknown>> | null) };
    let description = dto.description;
    if (dto.description !== undefined && lang !== DEFAULT_LANG) {
      translations[lang] = { ...translations[lang], description: dto.description };
      description = undefined;
    }

    const clubData: Prisma.ClubUncheckedUpdateInput = {
      name: dto.name,
      description,
      translations:
        dto.description !== undefined && lang !== DEFAULT_LANG ? (translations as Prisma.InputJsonObject) : undefined,
      logoUrl: dto.logoUrl,
      bannerUrl: dto.bannerUrl,
      photos: dto.photos,
      address: dto.address === null ? '' : dto.address,
      cityId: dto.cityId,
      latitude: dto.latitude,
      longitude: dto.longitude,
      phone: dto.phone,
      email: dto.email,
      openingHours,
      amenities: dto.amenities?.map((a) => a.trim()).filter(Boolean),
    };
    const orgData = {
      name: dto.name,
      logoUrl: dto.logoUrl,
      email: dto.email,
      phone: dto.phone,
      address: dto.address,
      website: dto.website,
      socialLinks: dto.socialLinks ? socialLinksJson(dto.socialLinks) : undefined,
      ...(lang === DEFAULT_LANG && dto.description !== undefined ? { description: dto.description } : {}),
    };
    const changed = Object.keys(dto);
    await this.prisma.$transaction(async (tx) => {
      await tx.club.update({ where: { id: clubId }, data: clubData });
      await tx.organization.update({ where: { id: club.organizationId }, data: orgData });
      await this.audit.record(
        {
          actorId,
          action: 'club.updated',
          entityType: 'Club',
          entityId: clubId,
          organizationId: club.organizationId,
          before: pick({ ...club, website: club.organization.website, socialLinks: club.organization.socialLinks }, changed),
          after: pick({ ...clubData, website: dto.website, socialLinks: dto.socialLinks, description: dto.description }, changed),
        },
        tx,
      );
    });
    await this.media.release(imagesBefore, imagesAfter);
    return this.profile(clubId);
  }

  // --------------------------------------------------------------- courts

  async courts(clubId: string) {
    const club = await this.prisma.club.findUnique({ where: { id: clubId }, select: { id: true, openingHours: true } });
    if (!club) throw new NotFoundException(t('errors.clubs.notFound'));
    const now = new Date();
    const courts = await this.prisma.court.findMany({
      where: { clubId },
      orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { number: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
      select: {
        ...courtSelect,
        _count: {
          select: {
            bookings: {
              where: { startTime: { gte: now }, status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] } },
            },
          },
        },
      },
    });
    const week = parseOpeningHours(club.openingHours);
    return {
      clubHours: week ? toStoredHours(week) : null,
      courts: courts.map(({ _count, ...court }) => ({ ...court, upcomingBookings: _count.bookings })),
    };
  }

  async createCourt(actorId: string, clubId: string, dto: CreateCourtDto) {
    const club = await this.prisma.club.findUnique({ where: { id: clubId } });
    if (!club) throw new NotFoundException(t('errors.clubs.notFound'));
    this.media.assertOwn([], dto.photos);
    const court = await this.prisma.$transaction(async (tx) => {
      const number =
        dto.number ??
        ((await tx.court.aggregate({ where: { clubId }, _max: { number: true } }))._max.number ?? 0) + 1;
      const created = await tx.court.create({
        data: {
          clubId,
          cityId: club.cityId,
          name: dto.name,
          number,
          surface: dto.surface,
          indoor: dto.indoor ?? false,
          lighting: dto.lighting ?? false,
          pricePerHour: dto.pricePerHour ?? null,
          photos: dto.photos ?? [],
        },
        select: courtSelect,
      });
      await this.audit.record(
        { actorId, action: 'court.created', entityType: 'Court', entityId: created.id, organizationId: club.organizationId, after: created },
        tx,
      );
      return created;
    });
    return court;
  }

  async updateCourt(actorId: string, courtId: string, dto: CourtDto) {
    const court = await this.findCourt(courtId);
    this.media.assertOwn(court.photos, dto.photos);
    const data = {
      name: dto.name,
      number: dto.number,
      surface: dto.surface,
      indoor: dto.indoor,
      lighting: dto.lighting,
      pricePerHour: dto.pricePerHour,
      photos: dto.photos,
    };
    const changed = Object.keys(dto);
    const updated = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.court.update({ where: { id: courtId }, data, select: courtSelect });
      await this.audit.record(
        {
          actorId,
          action: 'court.updated',
          entityType: 'Court',
          entityId: courtId,
          organizationId: court.club.organizationId,
          before: pick(court, changed),
          after: pick(updated, changed),
        },
        tx,
      );
      return updated;
    });
    if (dto.photos) await this.media.release(court.photos, dto.photos);
    return updated;
  }

  /**
   * Changes the status. Existing bookings are kept (the club decides what to
   * do with them); the response says how many are affected.
   */
  async setCourtStatus(actorId: string, courtId: string, dto: SetCourtStatusDto) {
    const court = await this.findCourt(courtId);
    if (court.archivedAt) throw new ConflictException(t('errors.courts.archived'));
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.court.update({ where: { id: courtId }, data: { status: dto.status }, select: courtSelect });
      await this.audit.record(
        {
          actorId,
          action: 'court.status.changed',
          entityType: 'Court',
          entityId: courtId,
          organizationId: court.club.organizationId,
          before: { status: court.status },
          after: { status: dto.status },
          reason: dto.reason,
        },
        tx,
      );
      return row;
    });
    return { ...updated, affectedBookings: dto.status === CourtStatus.AVAILABLE ? 0 : await this.upcomingBookings(courtId) };
  }

  /** Archive (hide, keep history) or restore a court. */
  async setArchived(actorId: string, courtId: string, archived: boolean, reason?: string) {
    const court = await this.findCourt(courtId);
    if (!!court.archivedAt === archived) return { ...(await this.findCourt(courtId)), affectedBookings: 0 };
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.court.update({
        where: { id: courtId },
        data: { archivedAt: archived ? new Date() : null },
        select: courtSelect,
      });
      await this.audit.record(
        {
          actorId,
          action: archived ? 'court.archived' : 'court.restored',
          entityType: 'Court',
          entityId: courtId,
          organizationId: court.club.organizationId,
          reason,
        },
        tx,
      );
      return row;
    });
    return { ...updated, affectedBookings: archived ? await this.upcomingBookings(courtId) : 0 };
  }

  async setAvailability(actorId: string, courtId: string, dto: CourtAvailabilityDto) {
    const court = await this.findCourt(courtId);
    let windows: { weekday: number; opensAt: string; closesAt: string }[];
    try {
      windows = [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) =>
        validateWindows(dto.windows.filter((w) => w.weekday === weekday)).map((w) => ({ weekday, ...w })),
      );
    } catch (error) {
      throw hoursError(error);
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.courtAvailability.deleteMany({ where: { courtId } });
      if (windows.length) await tx.courtAvailability.createMany({ data: windows.map((w) => ({ ...w, courtId })) });
      await this.audit.record(
        {
          actorId,
          action: 'court.availability.changed',
          entityType: 'Court',
          entityId: courtId,
          organizationId: court.club.organizationId,
          before: { windows: court.availability },
          after: { windows },
        },
        tx,
      );
      return tx.court.findUniqueOrThrow({ where: { id: courtId }, select: courtSelect });
    });
  }

  private async findCourt(courtId: string) {
    const court = await this.prisma.court.findUnique({
      where: { id: courtId },
      select: { ...courtSelect, club: { select: { organizationId: true } } },
    });
    if (!court) throw new NotFoundException(t('errors.courts.notFound'));
    return court;
  }

  private upcomingBookings(courtId: string) {
    return this.prisma.booking.count({
      where: { courtId, startTime: { gte: new Date() }, status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] } },
    });
  }
}
