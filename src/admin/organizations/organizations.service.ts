import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AffiliationStatus, OrganizationType, Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { MediaService } from '../../uploads/media.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { orderBy, pageArgs, searchText, toPage } from '../../common/pagination.js';
import { t } from '../../i18n/i18n.js';
import { localize } from '../../i18n/localize.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  CreateOrganizationDto,
  ListAffiliationsQueryDto,
  ListOrganizationsQueryDto,
  OrganizationProfileDto,
  SetOrganizationStatusDto,
} from './organizations.dto.js';
import { socialLinksJson } from './organizations.dto.js';

export type AffiliationAction = 'approve' | 'suspend' | 'end';

/** Allowed affiliation changes: action → statuses it may start from. */
const AFFILIATION_FROM: Record<AffiliationAction, AffiliationStatus[]> = {
  approve: [AffiliationStatus.PENDING, AffiliationStatus.SUSPENDED],
  suspend: [AffiliationStatus.ACTIVE],
  end: [AffiliationStatus.PENDING, AffiliationStatus.ACTIVE, AffiliationStatus.SUSPENDED],
};
const AFFILIATION_TO: Record<AffiliationAction, AffiliationStatus> = {
  approve: AffiliationStatus.ACTIVE,
  suspend: AffiliationStatus.SUSPENDED,
  end: AffiliationStatus.ENDED,
};

/** The status an affiliation moves to, or null when the change isn't allowed. */
export function nextAffiliationStatus(from: AffiliationStatus, action: AffiliationAction): AffiliationStatus | null {
  return AFFILIATION_FROM[action].includes(from) ? AFFILIATION_TO[action] : null;
}

export const slugify = (name: string) =>
  `${
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'org'
  }-${randomBytes(3).toString('hex')}`;


/** The subset of `source` listed in `keys`, for audit before/after. */
export const pick = (source: object, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(source).filter(([key]) => keys.includes(key)));

const affiliationSelect = {
  id: true,
  status: true,
  requestedAt: true,
  validatedAt: true,
  endedAt: true,
  reason: true,
  updatedAt: true,
} satisfies Prisma.OrganizationAffiliationSelect;

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly media: MediaService,
  ) {}

  async list(query: ListOrganizationsQueryDto) {
    const q = searchText(query.q);
    const where: Prisma.OrganizationWhereInput = {
      type: query.type,
      status: query.status,
      ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.organization.count({ where }),
      this.prisma.organization.findMany({
        where,
        ...pageArgs(query),
        orderBy: orderBy(query.sort, ['name', 'createdAt', 'status'], { field: 'name', direction: 'asc' }),
        select: {
          id: true,
          type: true,
          name: true,
          status: true,
          logoUrl: true,
          createdAt: true,
          club: { select: { id: true, city: { select: { name: true } }, _count: { select: { courts: { where: { archivedAt: null } } } } } },
          memberships: {
            where: { status: { in: [AffiliationStatus.ACTIVE, AffiliationStatus.PENDING] } },
            select: { status: true, parent: { select: { id: true, name: true } } },
          },
          _count: {
            select: {
              members: { where: { revokedAt: null } },
              affiliations: { where: { status: AffiliationStatus.ACTIVE } },
            },
          },
        },
      }),
    ]);
    return toPage(
      rows.map(({ club, _count, memberships, ...org }) => ({
        ...org,
        club: club && { id: club.id, city: club.city.name, courts: club._count.courts },
        federations: memberships.map((m) => ({ ...m.parent, status: m.status })),
        administrators: _count.members,
        affiliatedClubs: _count.affiliations,
      })),
      total,
      query,
    );
  }

  async detail(id: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id },
      include: {
        country: { select: { id: true, name: true, translations: true } },
        club: {
          select: {
            id: true,
            city: { select: { id: true, name: true } },
            _count: { select: { courts: { where: { archivedAt: null } }, bookings: true } },
          },
        },
        memberships: {
          orderBy: { requestedAt: 'desc' },
          select: { ...affiliationSelect, parent: { select: { id: true, name: true, type: true } } },
        },
        members: {
          where: { revokedAt: null },
          orderBy: { grantedAt: 'asc' },
          select: {
            id: true,
            grantedAt: true,
            role: { select: { key: true, name: true } },
            user: { select: { id: true, firstname: true, lastname: true, msisdn: true, status: true } },
          },
        },
        _count: { select: { affiliations: { where: { status: AffiliationStatus.ACTIVE } } } },
      },
    });
    if (!org) throw new NotFoundException(t('errors.organizations.notFound'));
    const { country, club, _count, members, ...rest } = org;
    return {
      ...rest,
      country: country && localize(country),
      club: club && { id: club.id, city: club.city, courts: club._count.courts, bookings: club._count.bookings },
      administrators: members,
      affiliatedClubs: _count.affiliations,
    };
  }

  /** Creates an organization (and, for a club, its Club row). */
  async create(actorId: string, dto: CreateOrganizationDto) {
    if (dto.type === OrganizationType.CLUB && !dto.cityId) {
      throw new BadRequestException(t('errors.organizations.cityRequired'));
    }
    const city = dto.cityId ? await this.prisma.city.findUnique({ where: { id: dto.cityId } }) : null;
    if (dto.cityId && !city) throw new NotFoundException(t('errors.accessRequests.cityNotFound'));
    this.media.assertOwn([], dto.logoUrl);

    const created = await this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: {
          type: dto.type,
          name: dto.name,
          slug: slugify(dto.name),
          description: dto.description,
          logoUrl: dto.logoUrl,
          email: dto.email,
          phone: dto.phone,
          website: dto.website,
          address: dto.address,
          countryId: dto.countryId ?? city?.countryId,
          socialLinks: dto.socialLinks ? socialLinksJson(dto.socialLinks) : undefined,
        },
      });
      if (dto.type === OrganizationType.CLUB && city) {
        await tx.club.create({
          data: {
            organizationId: organization.id,
            name: dto.name,
            description: dto.description,
            logoUrl: dto.logoUrl,
            email: dto.email,
            phone: dto.phone,
            address: dto.address ?? '',
            cityId: city.id,
          },
        });
      }
      await this.audit.record(
        {
          actorId,
          action: 'organization.created',
          entityType: 'Organization',
          entityId: organization.id,
          organizationId: organization.id,
          after: { type: dto.type, name: dto.name, cityId: dto.cityId ?? null },
        },
        tx,
      );
      return organization;
    });
    return this.detail(created.id);
  }

  async setStatus(actorId: string, id: string, dto: SetOrganizationStatusDto) {
    const org = await this.prisma.organization.findUnique({ where: { id } });
    if (!org) throw new NotFoundException(t('errors.organizations.notFound'));
    if (org.status !== dto.status) {
      await this.prisma.$transaction(async (tx) => {
        await tx.organization.update({ where: { id }, data: { status: dto.status } });
        await this.audit.record(
          {
            actorId,
            action: 'organization.status.changed',
            entityType: 'Organization',
            entityId: id,
            organizationId: id,
            before: { status: org.status },
            after: { status: dto.status },
            reason: dto.reason,
          },
          tx,
        );
      });
    }
    return this.detail(id);
  }

  /** Federation (or any organization) profile, checked against `type`. */
  async profile(id: string, type: OrganizationType) {
    const org = await this.detail(id);
    if (org.type !== type) {
      throw new NotFoundException(t('errors.organizations.wrongType', { type }));
    }
    return org;
  }

  async updateProfile(actorId: string, id: string, type: OrganizationType, dto: OrganizationProfileDto) {
    const org = await this.profile(id, type);
    this.media.assertOwn(org.logoUrl, dto.logoUrl);
    const data = {
      name: dto.name,
      description: dto.description,
      logoUrl: dto.logoUrl,
      email: dto.email,
      phone: dto.phone,
      website: dto.website,
      address: dto.address,
      countryId: dto.countryId,
      socialLinks: dto.socialLinks ? socialLinksJson(dto.socialLinks) : undefined,
    };
    const changed = Object.keys(data).filter((key) => data[key as keyof typeof data] !== undefined);
    await this.prisma.$transaction(async (tx) => {
      await tx.organization.update({ where: { id }, data });
      await this.audit.record(
        {
          actorId,
          action: 'organization.updated',
          entityType: 'Organization',
          entityId: id,
          organizationId: id,
          before: pick(org, changed),
          after: pick(data, changed),
        },
        tx,
      );
    });
    if (dto.logoUrl !== undefined) await this.media.release(org.logoUrl, dto.logoUrl);
    return this.profile(id, type);
  }

  // ------------------------------------------------------- affiliations

  async affiliatedClubs(federationId: string, query: ListAffiliationsQueryDto) {
    await this.profile(federationId, OrganizationType.FEDERATION);
    const q = searchText(query.q);
    const where: Prisma.OrganizationAffiliationWhereInput = {
      parentOrgId: federationId,
      status: query.status ?? { not: AffiliationStatus.ENDED },
      ...(q ? { member: { name: { contains: q, mode: 'insensitive' } } } : {}),
    };
    const [total, rows, counts] = await this.prisma.$transaction([
      this.prisma.organizationAffiliation.count({ where }),
      this.prisma.organizationAffiliation.findMany({
        where,
        ...pageArgs(query),
        orderBy: [{ status: 'asc' }, { requestedAt: 'desc' }],
        select: {
          ...affiliationSelect,
          member: {
            select: {
              id: true,
              name: true,
              status: true,
              logoUrl: true,
              email: true,
              phone: true,
              club: {
                select: {
                  id: true,
                  city: { select: { name: true } },
                  _count: { select: { courts: { where: { archivedAt: null } } } },
                },
              },
            },
          },
        },
      }),
      this.prisma.organizationAffiliation.groupBy({
        by: ['status'],
        where: { parentOrgId: federationId },
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
    ]);
    return {
      ...toPage(
        rows.map(({ member: { club, ...member }, ...affiliation }) => ({
          ...affiliation,
          club: {
            ...member,
            clubId: club?.id ?? null,
            city: club?.city.name ?? null,
            courts: club?._count.courts ?? 0,
          },
        })),
        total,
        query,
      ),
      counts: Object.fromEntries(counts.map((c) => [c.status, (c._count as { _all: number })._all])),
    };
  }

  /** A club asks to join a federation (or asks again after it ended). */
  async requestAffiliation(actorId: string, clubOrgId: string, federationId: string) {
    await this.profile(federationId, OrganizationType.FEDERATION);
    const existing = await this.prisma.organizationAffiliation.findUnique({
      where: { memberOrgId_parentOrgId: { memberOrgId: clubOrgId, parentOrgId: federationId } },
    });
    if (existing && existing.status !== AffiliationStatus.ENDED) {
      throw new ConflictException(t('errors.organizations.affiliationExists'));
    }
    return this.writeAffiliation(actorId, clubOrgId, federationId, existing?.id ?? null, AffiliationStatus.PENDING, 'organization.affiliation.requested');
  }

  /** A federation affiliates a club directly (no request needed). */
  async addClub(actorId: string, federationId: string, clubOrgId: string) {
    await this.profile(federationId, OrganizationType.FEDERATION);
    const club = await this.prisma.organization.findUnique({ where: { id: clubOrgId } });
    if (!club || club.type !== OrganizationType.CLUB) {
      throw new NotFoundException(t('errors.organizations.wrongType', { type: OrganizationType.CLUB }));
    }
    const existing = await this.prisma.organizationAffiliation.findUnique({
      where: { memberOrgId_parentOrgId: { memberOrgId: clubOrgId, parentOrgId: federationId } },
    });
    if (existing && existing.status !== AffiliationStatus.ENDED) {
      throw new ConflictException(t('errors.organizations.affiliationExists'));
    }
    return this.writeAffiliation(actorId, clubOrgId, federationId, existing?.id ?? null, AffiliationStatus.ACTIVE, 'organization.affiliation.added');
  }

  async decide(actorId: string, federationId: string, affiliationId: string, action: AffiliationAction, reason?: string) {
    const affiliation = await this.prisma.organizationAffiliation.findFirst({
      where: { id: affiliationId, parentOrgId: federationId },
    });
    if (!affiliation) throw new NotFoundException(t('errors.organizations.affiliationNotFound'));
    const next = nextAffiliationStatus(affiliation.status, action);
    if (!next) {
      throw new ConflictException({ message: t('errors.organizations.affiliationTransition'), code: 'INVALID_TRANSITION' });
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.organizationAffiliation.update({
        where: { id: affiliationId },
        data: {
          status: next,
          reason: reason ?? null,
          ...(next === AffiliationStatus.ACTIVE ? { validatedAt: now, validatedById: actorId, endedAt: null } : {}),
          ...(next === AffiliationStatus.ENDED ? { endedAt: now } : {}),
        },
      });
      await this.audit.record(
        {
          actorId,
          action: `organization.affiliation.${action === 'approve' ? 'validated' : action === 'suspend' ? 'suspended' : 'ended'}`,
          entityType: 'OrganizationAffiliation',
          entityId: affiliationId,
          organizationId: federationId,
          before: { status: affiliation.status },
          after: { status: next },
          reason,
        },
        tx,
      );
      // Also visible in the club's own log.
      await this.audit.record(
        {
          actorId,
          action: `organization.affiliation.${action === 'approve' ? 'validated' : action === 'suspend' ? 'suspended' : 'ended'}`,
          entityType: 'OrganizationAffiliation',
          entityId: affiliationId,
          organizationId: affiliation.memberOrgId,
          before: { status: affiliation.status },
          after: { status: next },
          reason,
        },
        tx,
      );
    });
    return this.prisma.organizationAffiliation.findUnique({ where: { id: affiliationId }, select: affiliationSelect });
  }

  private async writeAffiliation(
    actorId: string,
    memberOrgId: string,
    parentOrgId: string,
    existingId: string | null,
    status: AffiliationStatus,
    action: string,
  ) {
    const now = new Date();
    const data = {
      status,
      requestedAt: now,
      requestedById: actorId,
      endedAt: null,
      reason: null,
      ...(status === AffiliationStatus.ACTIVE ? { validatedAt: now, validatedById: actorId } : { validatedAt: null, validatedById: null }),
    };
    return this.prisma.$transaction(async (tx) => {
      const row = existingId
        ? await tx.organizationAffiliation.update({ where: { id: existingId }, data })
        : await tx.organizationAffiliation.create({ data: { ...data, memberOrgId, parentOrgId } });
      for (const organizationId of [memberOrgId, parentOrgId]) {
        await this.audit.record(
          { actorId, action, entityType: 'OrganizationAffiliation', entityId: row.id, organizationId, after: { status, memberOrgId, parentOrgId } },
          tx,
        );
      }
      return row;
    });
  }
}

