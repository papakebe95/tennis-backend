import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AccessRequestStatus,
  OrganizationStatus,
  OrganizationType,
  Prisma,
  RoleScope,
  UserStatus,
} from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { RoleGrantsService, escalation } from '../admin/users/role-grants.service.js';
import { AuditService } from '../audit/audit.service.js';
import { GLOBAL_SCOPE, missingFor, type Grant } from '../authz/scope.js';
import { orderBy, pageArgs, searchText, toPage } from '../common/pagination.js';
import { t } from '../i18n/i18n.js';
import { localize } from '../i18n/localize.js';
import {
  accessApproved,
  accessInfoRequested,
  accessRejected,
  accessRequestSubmitted,
} from '../notifications/notification-messages.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  CreateAccessRequestDto,
  ListAccessRequestsQueryDto,
  ProposedOrganizationDto,
} from './access-requests.dto.js';

const OPEN: AccessRequestStatus[] = [AccessRequestStatus.PENDING, AccessRequestStatus.INFO_REQUESTED];

const requestSelect = {
  id: true,
  status: true,
  message: true,
  proposedOrganization: true,
  infoRequest: true,
  infoResponse: true,
  decisionReason: true,
  reviewedAt: true,
  createdAt: true,
  updatedAt: true,
  role: { select: { id: true, key: true, name: true, scope: true, organizationType: true } },
  organization: { select: { id: true, name: true, type: true, status: true } },
  reviewer: { select: { id: true, firstname: true, lastname: true } },
} satisfies Prisma.AccessRequestSelect;

const adminSelect = {
  ...requestSelect,
  user: {
    select: { id: true, firstname: true, lastname: true, email: true, msisdn: true, status: true, createdAt: true },
  },
} satisfies Prisma.AccessRequestSelect;

type Tx = Prisma.TransactionClient;

export interface ValidatedRequest {
  role: { id: string; key: string; name: string; scope: RoleScope };
  organizationId: string | null;
  proposedOrganization: ProposedOrganizationDto | null;
  message: string | null;
}

@Injectable()
export class AccessRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly grants: RoleGrantsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------- public

  /** What the registration form offers: self-registrable profiles, places. */
  async options() {
    const [roles, countries] = await Promise.all([
      this.prisma.role.findMany({
        where: { selfRegistrable: true },
        orderBy: { name: 'asc' },
        select: { key: true, name: true, description: true, scope: true, organizationType: true },
      }),
      this.prisma.country.findMany({
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          translations: true,
          cities: { orderBy: { name: 'asc' }, select: { id: true, name: true, translations: true } },
        },
      }),
    ]);
    return {
      roles,
      countries: countries.map(({ cities, ...country }) => ({
        ...localize(country),
        cities: cities.map((city) => localize(city)),
      })),
    };
  }

  /** Active organizations an applicant can ask to administer. */
  async searchOrganizations(type: OrganizationType, q?: string) {
    const text = searchText(q);
    const rows = await this.prisma.organization.findMany({
      where: {
        type,
        status: OrganizationStatus.ACTIVE,
        ...(text ? { name: { contains: text, mode: 'insensitive' } } : {}),
      },
      orderBy: { name: 'asc' },
      take: 20,
      select: { id: true, name: true, type: true, club: { select: { city: { select: { name: true } } } } },
    });
    return rows.map(({ club, ...org }) => ({ ...org, city: club?.city.name ?? null }));
  }

  // ------------------------------------------------------------- applicant

  /**
   * Checks a request before anything is written. `userId` is null for a new
   * account (nothing held yet).
   */
  async validate(userId: string | null, dto: CreateAccessRequestDto): Promise<ValidatedRequest> {
    const role = await this.prisma.role.findUnique({ where: { key: dto.roleKey } });
    if (!role?.selfRegistrable || role.scope === RoleScope.COMPETITION) {
      throw new BadRequestException(t('errors.accessRequests.roleNotOffered'));
    }
    const proposed = dto.proposedOrganization ?? null;
    const organizationId = dto.organizationId ?? null;

    if (role.scope === RoleScope.GLOBAL) {
      if (organizationId || proposed) throw new BadRequestException(t('errors.accessRequests.noOrganization'));
    } else {
      if (!organizationId && !proposed) throw new BadRequestException(t('errors.accessRequests.needsOrganization'));
      if (organizationId && proposed) throw new BadRequestException(t('errors.accessRequests.oneOrganization'));
      const wrongType = (type: OrganizationType) =>
        new BadRequestException(t('errors.accessRequests.organizationType', { type: role.organizationType ?? type }));
      if (organizationId) {
        const organization = await this.prisma.organization.findUnique({ where: { id: organizationId } });
        if (!organization) throw new NotFoundException(t('errors.admin.organizationNotFound'));
        if (organization.status !== OrganizationStatus.ACTIVE) {
          throw new BadRequestException(t('errors.accessRequests.organizationInactive'));
        }
        if (role.organizationType && organization.type !== role.organizationType) throw wrongType(organization.type);
      } else if (proposed) {
        if (role.organizationType && proposed.type !== role.organizationType) throw wrongType(proposed.type);
        if (proposed.type === OrganizationType.CLUB && !proposed.cityId) {
          throw new BadRequestException(t('errors.accessRequests.cityRequired'));
        }
        if (proposed.cityId) {
          const city = await this.prisma.city.findUnique({ where: { id: proposed.cityId } });
          if (!city) throw new NotFoundException(t('errors.accessRequests.cityNotFound'));
          proposed.countryId = city.countryId;
        }
      }
    }

    if (userId) {
      const [open, held] = await Promise.all([
        this.prisma.accessRequest.count({
          where: { userId, roleId: role.id, status: { in: OPEN }, organizationId },
        }),
        organizationId || role.scope === RoleScope.GLOBAL
          ? this.prisma.userRole.count({ where: { userId, roleId: role.id, revokedAt: null, organizationId } })
          : 0,
      ]);
      if (open) throw new ConflictException(t('errors.accessRequests.alreadyOpen'));
      if (held) throw new ConflictException(t('errors.accessRequests.alreadyGranted'));
    }
    return {
      role: { id: role.id, key: role.key, name: role.name, scope: role.scope },
      organizationId,
      proposedOrganization: proposed,
      message: dto.message ?? null,
    };
  }

  async createInTx(tx: Tx, userId: string, request: ValidatedRequest) {
    const created = await tx.accessRequest.create({
      data: {
        userId,
        roleId: request.role.id,
        organizationId: request.organizationId,
        proposedOrganization: request.proposedOrganization
          ? proposedJson(request.proposedOrganization)
          : undefined,
        message: request.message,
      },
    });
    await this.audit.record(
      {
        actorId: userId,
        action: 'access_request.submitted',
        entityType: 'AccessRequest',
        entityId: created.id,
        organizationId: request.organizationId,
        after: { role: request.role.key, organizationId: request.organizationId, proposedOrganization: request.proposedOrganization },
      },
      tx,
    );
    return created;
  }

  /** A signed-in user (player, pending applicant…) asks for a role. */
  async create(userId: string, dto: CreateAccessRequestDto) {
    const validated = await this.validate(userId, dto);
    const created = await this.prisma.$transaction((tx) => this.createInTx(tx, userId, validated));
    await this.notifyReviewers(userId, validated.role.name);
    return this.findMine(userId, created.id);
  }

  mine(userId: string) {
    return this.prisma.accessRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: requestSelect,
    });
  }

  async respond(userId: string, id: string, response: string) {
    const request = await this.findMine(userId, id);
    if (request.status !== AccessRequestStatus.INFO_REQUESTED) {
      throw new ConflictException(t('errors.accessRequests.notInfoRequested'));
    }
    await this.transition(userId, id, 'access_request.answered', {
      status: AccessRequestStatus.PENDING,
      infoResponse: response,
    });
    return this.findMine(userId, id);
  }

  async cancel(userId: string, id: string) {
    const request = await this.findMine(userId, id);
    if (!OPEN.includes(request.status)) throw new ConflictException(t('errors.accessRequests.notOpen'));
    await this.transition(userId, id, 'access_request.cancelled', { status: AccessRequestStatus.CANCELLED });
    return this.findMine(userId, id);
  }

  /** Tells every platform-level reviewer that a request is waiting. */
  async notifyReviewers(applicantId: string, roleName: string) {
    const [applicant, reviewers] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: applicantId }, select: { firstname: true, lastname: true } }),
      this.prisma.user.findMany({
        where: {
          status: UserStatus.ACTIVE,
          roles: {
            some: {
              revokedAt: null,
              role: { scope: RoleScope.GLOBAL, permissions: { some: { permissionKey: 'access_request.review' } } },
            },
          },
        },
        select: { id: true },
      }),
    ]);
    const name = applicant ? `${applicant.firstname} ${applicant.lastname}` : '';
    for (const reviewer of reviewers) {
      await this.notifications.notify(reviewer.id, accessRequestSubmitted(name, roleName));
    }
  }

  private async findMine(userId: string, id: string) {
    const request = await this.prisma.accessRequest.findFirst({ where: { id, userId }, select: requestSelect });
    if (!request) throw new NotFoundException(t('errors.accessRequests.notFound'));
    return request;
  }

  // ------------------------------------------------------------- reviewers

  async list(query: ListAccessRequestsQueryDto) {
    const q = searchText(query.q);
    const status = query.status ?? 'OPEN';
    const where: Prisma.AccessRequestWhereInput = {
      ...(status === 'OPEN' ? { status: { in: OPEN } } : status === 'ALL' ? {} : { status }),
      ...(query.roleKey ? { role: { key: query.roleKey } } : {}),
      ...(q
        ? {
            user: {
              OR: [
                { firstname: { contains: q, mode: 'insensitive' } },
                { lastname: { contains: q, mode: 'insensitive' } },
                { email: { contains: q, mode: 'insensitive' } },
                { msisdn: { contains: q.replace(/\D/g, '') || q } },
              ],
            },
          }
        : {}),
    };
    const [total, items, counts] = await this.prisma.$transaction([
      this.prisma.accessRequest.count({ where }),
      this.prisma.accessRequest.findMany({
        where,
        ...pageArgs(query),
        orderBy: orderBy(query.sort, ['createdAt', 'updatedAt', 'status'], { field: 'createdAt', direction: 'asc' }),
        select: adminSelect,
      }),
      this.prisma.accessRequest.groupBy({ by: ['status'], _count: { _all: true }, orderBy: { status: 'asc' } }),
    ]);
    return {
      ...toPage(items, total, query),
      counts: Object.fromEntries(counts.map((c) => [c.status, (c._count as { _all: number })._all])),
    };
  }

  async detail(id: string) {
    const request = await this.prisma.accessRequest.findUnique({ where: { id }, select: adminSelect });
    if (!request) throw new NotFoundException(t('errors.accessRequests.notFound'));
    const [grants, history] = await Promise.all([
      this.prisma.userRole.findMany({
        where: { userId: request.user.id, revokedAt: null },
        select: {
          id: true,
          role: { select: { key: true, name: true, scope: true } },
          organization: { select: { id: true, name: true, type: true } },
          competition: { select: { id: true, name: true } },
        },
      }),
      this.prisma.accessRequest.findMany({
        where: { userId: request.user.id, id: { not: id } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, createdAt: true, role: { select: { name: true } } },
      }),
    ]);
    return { ...request, userGrants: grants, otherRequests: history };
  }

  /**
   * Approves: creates the proposed organization (if any), grants the role,
   * activates the account and closes the request — all or nothing.
   */
  async approve(actor: { id: string; grants: readonly Grant[] }, id: string, reason?: string) {
    const request = await this.prisma.accessRequest.findUnique({
      where: { id },
      include: {
        role: { include: { permissions: { select: { permissionKey: true } } } },
        organization: true,
        user: { select: { id: true, status: true } },
      },
    });
    if (!request) throw new NotFoundException(t('errors.accessRequests.notFound'));
    if (!OPEN.includes(request.status)) throw new ConflictException(t('errors.accessRequests.notOpen'));
    // A reviewer can't hand out, through approval, rights they don't hold.
    if (missingFor(actor.grants, request.role.permissions.map((p) => p.permissionKey), [GLOBAL_SCOPE]).length) {
      throw escalation();
    }
    if (request.organization && request.organization.status !== OrganizationStatus.ACTIVE) {
      throw new ConflictException(t('errors.accessRequests.organizationInactive'));
    }

    const scopeName = await this.prisma.$transaction(async (tx) => {
      let organizationId = request.organizationId;
      let organizationName = request.organization?.name ?? null;
      const proposed = request.proposedOrganization as ProposedOrganizationDto | null;
      if (!organizationId && proposed && request.role.scope === RoleScope.ORGANIZATION) {
        const organization = await createOrganization(tx, proposed);
        organizationId = organization.id;
        organizationName = organization.name;
        await this.audit.record(
          {
            actorId: actor.id,
            action: 'organization.created',
            entityType: 'Organization',
            entityId: organization.id,
            organizationId: organization.id,
            after: proposed,
          },
          tx,
        );
      }

      await this.grants.createInTx(tx, actor.id, request.userId, {
        role: request.role,
        chain: [],
        scopeName: organizationName ?? 'Tennis Back-Office',
        scope: {
          organizationId: request.role.scope === RoleScope.ORGANIZATION ? organizationId : null,
          competitionId: null,
        },
      }, reason);

      if (request.user.status === UserStatus.PENDING || request.user.status === UserStatus.REJECTED) {
        await tx.user.update({ where: { id: request.userId }, data: { status: UserStatus.ACTIVE } });
      }
      await tx.accessRequest.update({
        where: { id },
        data: {
          status: AccessRequestStatus.APPROVED,
          organizationId,
          reviewerId: actor.id,
          reviewedAt: new Date(),
          decisionReason: reason,
        },
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'access_request.approved',
          entityType: 'AccessRequest',
          entityId: id,
          organizationId,
          before: { status: request.status },
          after: { status: AccessRequestStatus.APPROVED },
          reason,
        },
        tx,
      );
      return organizationName ?? 'Tennis Back-Office';
    });

    await this.notifications.notify(request.userId, accessApproved(request.role.name, scopeName));
    return this.detail(id);
  }

  async reject(actorId: string, id: string, reason?: string) {
    const request = await this.openRequest(id);
    await this.prisma.$transaction(async (tx) => {
      await tx.accessRequest.update({
        where: { id },
        data: { status: AccessRequestStatus.REJECTED, reviewerId: actorId, reviewedAt: new Date(), decisionReason: reason },
      });
      // A pending applicant with nothing else going on is refused entirely.
      if (request.user.status === UserStatus.PENDING) {
        const [grants, open] = await Promise.all([
          tx.userRole.count({ where: { userId: request.userId, revokedAt: null } }),
          tx.accessRequest.count({ where: { userId: request.userId, status: { in: OPEN } } }),
        ]);
        if (grants === 0 && open === 0) {
          await tx.user.update({ where: { id: request.userId }, data: { status: UserStatus.REJECTED } });
        }
      }
      await this.audit.record(
        {
          actorId,
          action: 'access_request.rejected',
          entityType: 'AccessRequest',
          entityId: id,
          organizationId: request.organizationId,
          before: { status: request.status },
          after: { status: AccessRequestStatus.REJECTED },
          reason,
        },
        tx,
      );
    });
    await this.notifications.notify(request.userId, accessRejected(request.role.name));
    return this.detail(id);
  }

  async requestInfo(actorId: string, id: string, message: string) {
    const request = await this.openRequest(id);
    await this.prisma.$transaction(async (tx) => {
      await tx.accessRequest.update({
        where: { id },
        data: { status: AccessRequestStatus.INFO_REQUESTED, infoRequest: message, infoResponse: null, reviewerId: actorId },
      });
      await this.audit.record(
        {
          actorId,
          action: 'access_request.info_requested',
          entityType: 'AccessRequest',
          entityId: id,
          organizationId: request.organizationId,
          after: { infoRequest: message },
        },
        tx,
      );
    });
    await this.notifications.notify(request.userId, accessInfoRequested(request.role.name));
    return this.detail(id);
  }

  private async openRequest(id: string) {
    const request = await this.prisma.accessRequest.findUnique({
      where: { id },
      include: { role: true, user: { select: { status: true } } },
    });
    if (!request) throw new NotFoundException(t('errors.accessRequests.notFound'));
    if (!OPEN.includes(request.status)) throw new ConflictException(t('errors.accessRequests.notOpen'));
    return request;
  }

  private async transition(
    actorId: string,
    id: string,
    action: string,
    data: Prisma.AccessRequestUpdateInput,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.accessRequest.update({ where: { id }, data });
      await this.audit.record(
        { actorId, action, entityType: 'AccessRequest', entityId: id, organizationId: updated.organizationId, after: data },
        tx,
      );
    });
  }
}

/** The proposal as stored JSON (only the known fields). */
const proposedJson = (p: ProposedOrganizationDto): Prisma.InputJsonObject => ({
  type: p.type,
  name: p.name,
  cityId: p.cityId ?? null,
  countryId: p.countryId ?? null,
  address: p.address ?? null,
  phone: p.phone ?? null,
  email: p.email ?? null,
});

/** Creates an approved applicant's new organization (and its club row). */
async function createOrganization(tx: Tx, proposed: ProposedOrganizationDto) {
  const base = proposed.name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const organization = await tx.organization.create({
    data: {
      type: proposed.type,
      name: proposed.name,
      slug: `${base || 'org'}-${randomBytes(3).toString('hex')}`,
      email: proposed.email,
      phone: proposed.phone,
      address: proposed.address,
      countryId: proposed.countryId,
    },
  });
  if (proposed.type === OrganizationType.CLUB) {
    if (!proposed.cityId) throw new BadRequestException(t('errors.accessRequests.cityRequired'));
    await tx.club.create({
      data: {
        organizationId: organization.id,
        name: proposed.name,
        address: proposed.address ?? '',
        cityId: proposed.cityId,
        phone: proposed.phone,
        email: proposed.email,
      },
    });
  }
  return organization;
}
