import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { OrganizationType } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/jwt.strategy.js';
import { Authorize } from '../../authz/permission.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { t } from '../../i18n/i18n.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ClubsAdminService } from './clubs-admin.service.js';
import {
  AddAffiliatedClubDto,
  AffiliationDecisionDto,
  AffiliationRequestDto,
  CourtAvailabilityDto,
  CourtDto,
  CreateCourtDto,
  CreateOrganizationDto,
  ListAffiliationsQueryDto,
  ListOrganizationsQueryDto,
  OrganizationProfileDto,
  SetCourtStatusDto,
  SetOrganizationStatusDto,
  UpdateClubDto,
} from './organizations.dto.js';
import { OrganizationsService, type AffiliationAction } from './organizations.service.js';

/** Platform-wide organization management (Super Admin). */
@Controller('admin/organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  @Authorize('organization.view')
  list(@Query() query: ListOrganizationsQueryDto) {
    return this.organizations.list(query);
  }

  @Post()
  @Authorize('organization.create')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateOrganizationDto) {
    return this.organizations.create(user.userId, dto);
  }

  @Get(':id')
  @Authorize('organization.view')
  detail(@Param('id') id: string) {
    return this.organizations.detail(id);
  }

  @Patch(':id/status')
  @Authorize('organization.manage')
  setStatus(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: SetOrganizationStatusDto) {
    return this.organizations.setStatus(user.userId, id, dto);
  }
}

const ACTIONS: readonly AffiliationAction[] = ['approve', 'suspend', 'end'];

/** A federation's own space; `:id` is the federation's organization id. */
@Controller('admin/federations')
export class FederationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get(':id')
  @Authorize('federation.view', { resource: 'organization' })
  profile(@Param('id') id: string) {
    return this.organizations.profile(id, OrganizationType.FEDERATION);
  }

  @Patch(':id')
  @Authorize('federation.update', { resource: 'organization' })
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: OrganizationProfileDto) {
    return this.organizations.updateProfile(user.userId, id, OrganizationType.FEDERATION, dto);
  }

  @Get(':id/clubs')
  @Authorize('federation.clubs.view', { resource: 'organization' })
  clubs(@Param('id') id: string, @Query() query: ListAffiliationsQueryDto) {
    return this.organizations.affiliatedClubs(id, query);
  }

  @Post(':id/clubs')
  @Authorize('federation.clubs.validate', { resource: 'organization' })
  addClub(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: AddAffiliatedClubDto) {
    return this.organizations.addClub(user.userId, id, dto.clubOrganizationId);
  }

  @Post(':id/affiliations/:affiliationId/:action')
  @HttpCode(HttpStatus.OK)
  @Authorize('federation.clubs.validate', { resource: 'organization' })
  decide(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('affiliationId') affiliationId: string,
    @Param('action') action: string,
    @Body() dto: AffiliationDecisionDto,
  ) {
    if (!ACTIONS.includes(action as AffiliationAction)) throw new BadRequestException();
    return this.organizations.decide(user.userId, id, affiliationId, action as AffiliationAction, dto.reason);
  }
}

/** A club's own space; `:id` is the club id. */
@Controller('admin/clubs')
export class ClubsAdminController {
  constructor(
    private readonly clubs: ClubsAdminService,
    private readonly organizations: OrganizationsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get(':id')
  @Authorize('club.view', { resource: 'club' })
  profile(@Param('id') id: string) {
    return this.clubs.profile(id);
  }

  @Patch(':id')
  @Authorize('club.update', { resource: 'club' })
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateClubDto) {
    return this.clubs.update(user.userId, id, dto);
  }

  /** Ask a federation to affiliate this club. */
  @Post(':id/affiliations')
  @Authorize('club.update', { resource: 'club' })
  async requestAffiliation(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: AffiliationRequestDto) {
    const club = await this.prisma.club.findUnique({ where: { id }, select: { organizationId: true } });
    if (!club) throw new NotFoundException(t('errors.clubs.notFound'));
    return this.organizations.requestAffiliation(user.userId, club.organizationId, dto.federationId);
  }

  @Get(':id/courts')
  @Authorize('court.view', { resource: 'club' })
  courts(@Param('id') id: string) {
    return this.clubs.courts(id);
  }

  @Post(':id/courts')
  @Authorize('court.manage', { resource: 'club' })
  createCourt(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: CreateCourtDto) {
    return this.clubs.createCourt(user.userId, id, dto);
  }
}

@Controller('admin/courts')
export class CourtsAdminController {
  constructor(private readonly clubs: ClubsAdminService) {}

  @Patch(':courtId')
  @Authorize('court.manage', { resource: 'court', param: 'courtId' })
  update(@CurrentUser() user: AuthenticatedUser, @Param('courtId') courtId: string, @Body() dto: CourtDto) {
    return this.clubs.updateCourt(user.userId, courtId, dto);
  }

  @Patch(':courtId/status')
  @Authorize('court.manage', { resource: 'court', param: 'courtId' })
  setStatus(@CurrentUser() user: AuthenticatedUser, @Param('courtId') courtId: string, @Body() dto: SetCourtStatusDto) {
    return this.clubs.setCourtStatus(user.userId, courtId, dto);
  }

  @Post(':courtId/archive')
  @HttpCode(HttpStatus.OK)
  @Authorize('court.manage', { resource: 'court', param: 'courtId' })
  archive(@CurrentUser() user: AuthenticatedUser, @Param('courtId') courtId: string, @Body() dto: AffiliationDecisionDto) {
    return this.clubs.setArchived(user.userId, courtId, true, dto.reason);
  }

  @Post(':courtId/restore')
  @HttpCode(HttpStatus.OK)
  @Authorize('court.manage', { resource: 'court', param: 'courtId' })
  restore(@CurrentUser() user: AuthenticatedUser, @Param('courtId') courtId: string) {
    return this.clubs.setArchived(user.userId, courtId, false);
  }

  @Put(':courtId/availability')
  @Authorize('court.manage', { resource: 'court', param: 'courtId' })
  setAvailability(@CurrentUser() user: AuthenticatedUser, @Param('courtId') courtId: string, @Body() dto: CourtAvailabilityDto) {
    return this.clubs.setAvailability(user.userId, courtId, dto);
  }
}
