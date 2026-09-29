import { OrganizationType, RoleScope } from '@prisma/client';
import { ALL_PERMISSIONS, type PermissionKey } from './permissions.js';

// Roles the platform ships with. Created at boot when missing; after that the
// Super Admin owns their permissions (except system roles, which are reset
// from here at every boot so SUPER_ADMIN always has every permission).

export interface RoleDefinition {
  key: string;
  name: string;
  description: string;
  scope: RoleScope;
  organizationType?: OrganizationType;
  isSystem?: boolean;
  selfRegistrable?: boolean;
  permissions: readonly PermissionKey[];
}

const TOURNAMENT_RUN: PermissionKey[] = [
  'tournament.view',
  'tournament.update',
  'tournament.delete',
  'tournament.lifecycle.manage',
  'tournament.interrupt',
  'tournament.staff.manage',
  'tournament.announce',
  'registration.view',
  'registration.manage',
  'draw.view',
  'draw.manage',
  'draw.publish',
  'match.view',
  'match.schedule',
  'match.result.enter',
  'match.result.validate',
  'match.status.manage',
  'match.incident.report',
  'payment.view',
  'payment.record',
  'report.view',
  'report.export',
  'audit.view',
  'notification.broadcast',
];

export const SUPER_ADMIN_ROLE_KEY = 'SUPER_ADMIN';
/** Granted on a competition to whoever creates it. */
export const COMPETITION_ORGANIZER_ROLE_KEY = 'COMPETITION_ORGANIZER';

export const DEFAULT_ROLES: readonly RoleDefinition[] = [
  {
    key: SUPER_ADMIN_ROLE_KEY,
    name: 'Super Admin',
    description: 'Full access to the platform.',
    scope: RoleScope.GLOBAL,
    isSystem: true,
    permissions: ALL_PERMISSIONS.filter((p) => p !== 'match.assigned_only'),
  },
  {
    key: 'FEDERATION_ADMIN',
    name: 'Federation Admin',
    description: 'Runs a federation: profile, affiliated clubs, players, official competitions and rankings.',
    scope: RoleScope.ORGANIZATION,
    organizationType: OrganizationType.FEDERATION,
    selfRegistrable: true,
    permissions: [
      'federation.view',
      'federation.update',
      'federation.clubs.view',
      'federation.clubs.validate',
      'federation.players.view',
      'federation.rankings.view',
      'player.sport_profile.manage',
      'tournament.create',
      'user.roles.assign',
      ...TOURNAMENT_RUN,
      // Appoints tournament directors, so holds what they hold.
      'draw.modify_locked',
      'payment.refund',
    ],
  },
  {
    key: 'FEDERATION_OFFICIAL',
    name: 'Federation Official',
    description: 'Read access to federation data and rankings.',
    scope: RoleScope.ORGANIZATION,
    organizationType: OrganizationType.FEDERATION,
    permissions: [
      'federation.view',
      'federation.clubs.view',
      'federation.players.view',
      'federation.rankings.view',
      'tournament.view',
      'draw.view',
      'match.view',
      'report.view',
    ],
  },
  {
    key: 'CLUB_ADMIN',
    name: 'Club Admin',
    description: 'Runs a club: profile, courts, members, bookings, payments and club tournaments.',
    scope: RoleScope.ORGANIZATION,
    organizationType: OrganizationType.CLUB,
    selfRegistrable: true,
    permissions: [
      'club.view',
      'club.update',
      'club.dashboard.view',
      'court.view',
      'court.manage',
      'member.view',
      'member.manage',
      'membership.plan.manage',
      'booking.view',
      'booking.manage',
      'payment.refund',
      'tournament.create',
      'user.roles.assign',
      ...TOURNAMENT_RUN,
      'draw.modify_locked',
    ],
  },
  {
    key: 'CLUB_STAFF',
    name: 'Club Staff',
    description: 'Front desk: bookings, members and payments.',
    scope: RoleScope.ORGANIZATION,
    organizationType: OrganizationType.CLUB,
    permissions: [
      'club.view',
      'club.dashboard.view',
      'court.view',
      'member.view',
      'booking.view',
      'booking.manage',
      'payment.view',
      'payment.record',
      'tournament.view',
      'match.view',
    ],
  },
  {
    key: 'COACH',
    name: 'Coach',
    description: 'Club coach (coaching features to come).',
    scope: RoleScope.ORGANIZATION,
    organizationType: OrganizationType.CLUB,
    permissions: ['club.view', 'court.view', 'member.view', 'booking.view'],
  },
  {
    key: 'TOURNAMENT_ORGANIZER',
    name: 'Tournament Organizer',
    description: 'Independent organizer: may create tournaments and runs the ones they create.',
    scope: RoleScope.GLOBAL,
    selfRegistrable: true,
    permissions: ['tournament.create'],
  },
  {
    key: COMPETITION_ORGANIZER_ROLE_KEY,
    name: 'Competition Organizer',
    description: 'Runs one tournament end to end.',
    scope: RoleScope.COMPETITION,
    permissions: TOURNAMENT_RUN,
  },
  {
    key: 'TOURNAMENT_DIRECTOR',
    name: 'Tournament Director',
    description: 'Elevated powers inside one tournament, including changes after play has started.',
    scope: RoleScope.COMPETITION,
    permissions: [...TOURNAMENT_RUN, 'draw.modify_locked', 'payment.refund'],
  },
  {
    key: 'OFFICIAL',
    name: 'Official',
    description: 'Referee: enters results and reports incidents on assigned matches.',
    scope: RoleScope.COMPETITION,
    permissions: [
      'tournament.view',
      'draw.view',
      'match.view',
      'match.result.enter',
      'match.incident.report',
      'match.assigned_only',
    ],
  },
];
