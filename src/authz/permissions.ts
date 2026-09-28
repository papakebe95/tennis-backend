import { RoleScope } from '@prisma/client';

// ---------------------------------------------------------------------------
// The permission catalog. Code is the source of truth: a permission only means
// something if an endpoint checks it, so keys are never created from the UI.
// AuthzBootstrap syncs this list into the Permission table at boot; roles are
// composed from it (see default-roles.ts and the /admin/roles API).
// ---------------------------------------------------------------------------

const { GLOBAL, ORGANIZATION, COMPETITION } = RoleScope;

interface PermissionDefinition {
  module: string;
  description: string;
  scopes: RoleScope[];
}

export const PERMISSIONS = {
  // Platform
  'dashboard.global.view': { module: 'platform', description: 'View platform-wide KPIs', scopes: [GLOBAL] },
  'audit.view': { module: 'platform', description: 'Read the audit log', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },
  'report.view': { module: 'platform', description: 'View reports', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },
  'report.export': { module: 'platform', description: 'Export reports as CSV', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },
  'notification.broadcast': { module: 'platform', description: 'Send announcements to groups of users', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },

  // Identity & authorization
  'user.view': { module: 'identity', description: 'Search and view user accounts', scopes: [GLOBAL] },
  'user.update': { module: 'identity', description: 'Edit user account details', scopes: [GLOBAL] },
  'user.status.manage': { module: 'identity', description: 'Activate, suspend or disable accounts', scopes: [GLOBAL] },
  'user.password.reset': { module: 'identity', description: "Reset another user's password", scopes: [GLOBAL] },
  'user.roles.assign': { module: 'identity', description: 'Grant and revoke roles', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },
  'role.view': { module: 'identity', description: 'View roles and the permission catalog', scopes: [GLOBAL] },
  'role.manage': { module: 'identity', description: 'Create, edit and delete roles', scopes: [GLOBAL] },
  'access_request.review': { module: 'identity', description: 'Approve or reject access requests', scopes: [GLOBAL] },

  // Organizations
  'organization.create': { module: 'organization', description: 'Create federations, clubs and communities', scopes: [GLOBAL] },
  'organization.view': { module: 'organization', description: 'View every organization', scopes: [GLOBAL] },
  'organization.manage': { module: 'organization', description: 'Suspend, reactivate or archive organizations', scopes: [GLOBAL] },
  'federation.view': { module: 'organization', description: 'View a federation profile', scopes: [GLOBAL, ORGANIZATION] },
  'federation.update': { module: 'organization', description: 'Edit a federation profile', scopes: [GLOBAL, ORGANIZATION] },
  'federation.clubs.view': { module: 'organization', description: 'View affiliated clubs', scopes: [GLOBAL, ORGANIZATION] },
  'federation.clubs.validate': { module: 'organization', description: 'Validate or suspend club affiliations', scopes: [GLOBAL, ORGANIZATION] },
  'federation.players.view': { module: 'organization', description: 'View federation players', scopes: [GLOBAL, ORGANIZATION] },
  'federation.rankings.view': { module: 'organization', description: 'View federation rankings', scopes: [GLOBAL, ORGANIZATION] },
  'club.view': { module: 'organization', description: 'View a club profile', scopes: [GLOBAL, ORGANIZATION] },
  'club.update': { module: 'organization', description: 'Edit a club profile', scopes: [GLOBAL, ORGANIZATION] },
  'club.dashboard.view': { module: 'organization', description: 'View the club dashboard', scopes: [GLOBAL, ORGANIZATION] },

  // Club operations
  'court.view': { module: 'club', description: 'View courts', scopes: [GLOBAL, ORGANIZATION] },
  'court.manage': { module: 'club', description: 'Create and edit courts, pricing and availability', scopes: [GLOBAL, ORGANIZATION] },
  'member.view': { module: 'club', description: 'View club members', scopes: [GLOBAL, ORGANIZATION] },
  'member.manage': { module: 'club', description: 'Add, edit, renew and suspend memberships', scopes: [GLOBAL, ORGANIZATION] },
  'membership.plan.manage': { module: 'club', description: 'Manage membership plans', scopes: [GLOBAL, ORGANIZATION] },
  'booking.view': { module: 'club', description: 'View court bookings', scopes: [GLOBAL, ORGANIZATION] },
  'booking.manage': { module: 'club', description: 'Create, confirm and cancel bookings', scopes: [GLOBAL, ORGANIZATION] },
  'payment.view': { module: 'club', description: 'View payments', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },
  'payment.record': { module: 'club', description: 'Record payments', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },
  'payment.refund': { module: 'club', description: 'Refund or cancel payments', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },

  // Tournaments
  'tournament.view': { module: 'tournament', description: 'View tournaments in the back-office', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },
  'tournament.create': { module: 'tournament', description: 'Create tournaments', scopes: [GLOBAL, ORGANIZATION] },
  'tournament.update': { module: 'tournament', description: 'Edit tournament details, events and rules', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },
  'tournament.delete': { module: 'tournament', description: 'Delete draft tournaments', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },
  'tournament.lifecycle.manage': { module: 'tournament', description: 'Open/close registration, start, complete, cancel', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },
  'tournament.interrupt': { module: 'tournament', description: 'Interrupt and resume a tournament', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },
  'tournament.staff.manage': { module: 'tournament', description: 'Assign directors and officials', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },
  'tournament.announce': { module: 'tournament', description: 'Publish announcements to participants', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },
  'registration.view': { module: 'tournament', description: 'View registrations', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },
  'registration.manage': { module: 'tournament', description: 'Approve, reject and withdraw registrations', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },
  'draw.view': { module: 'tournament', description: 'View draws, including unpublished ones', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },
  'draw.manage': { module: 'tournament', description: 'Generate, shuffle and edit draft draws; fill empty places', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },
  'draw.publish': { module: 'tournament', description: 'Publish and lock draws', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },
  'draw.modify_locked': { module: 'tournament', description: 'Change a draw after play has started (replace players)', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },
  'match.view': { module: 'tournament', description: 'View tournament matches', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },
  'match.schedule': { module: 'tournament', description: 'Schedule matches on courts', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },
  'match.result.enter': { module: 'tournament', description: 'Enter match results', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },
  'match.result.validate': { module: 'tournament', description: 'Validate or correct match results', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },
  'match.status.manage': { module: 'tournament', description: 'Postpone, cancel, walkover, retirement, dispute', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },
  'match.incident.report': { module: 'tournament', description: 'Report match incidents', scopes: [GLOBAL, ORGANIZATION, COMPETITION] },
  // Restricting marker, not a grant: holders only see and act on matches
  // they are assigned to as official.
  'match.assigned_only': { module: 'tournament', description: 'Limit match access to assigned matches', scopes: [COMPETITION] },
} as const satisfies Record<string, PermissionDefinition>;

export type PermissionKey = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PermissionKey[];

export const isPermissionKey = (value: string): value is PermissionKey =>
  Object.hasOwn(PERMISSIONS, value);

/**
 * Markers that restrict rather than grant. They are ignored when comparing
 * what two users may do (anti-escalation checks).
 */
export const RESTRICTIONS: ReadonlySet<string> = new Set<PermissionKey>(['match.assigned_only']);
