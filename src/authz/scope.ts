import { RoleScope } from '@prisma/client';
import type { PermissionKey } from './permissions.js';

// ---------------------------------------------------------------------------
// Pure permission matching, kept free of Nest/Prisma so the rules are easy to
// test exhaustively.
//
// A resource resolves to a *scope chain*: the places a grant could sit and
// still cover it, most specific first. A court of club X resolves to
// [org X, GLOBAL]; a match of competition C hosted by club X resolves to
// [competition C, org X, GLOBAL]. A permission is held for the resource when
// any active grant carrying it sits on the chain.
//
// A federation does NOT inherit permissions over its affiliated clubs: the
// chain of a club never contains its federation. Federation powers over a
// club go through federation-specific permissions checked against the
// federation's own scope.
// ---------------------------------------------------------------------------

export type Scope =
  | { type: typeof RoleScope.GLOBAL }
  | { type: typeof RoleScope.ORGANIZATION; id: string }
  | { type: typeof RoleScope.COMPETITION; id: string };

export const GLOBAL_SCOPE: Scope = { type: RoleScope.GLOBAL };

export interface Grant {
  roleKey: string;
  scope: Scope;
  permissions: ReadonlySet<string>;
}

const sameScope = (a: Scope, b: Scope): boolean =>
  a.type === b.type &&
  (a.type === RoleScope.GLOBAL || a.id === (b as { id: string }).id);

/** True when some grant on `chain` carries `permission`. */
export function holds(
  grants: readonly Grant[],
  permission: PermissionKey,
  chain: readonly Scope[] = [GLOBAL_SCOPE],
): boolean {
  return grants.some(
    (grant) =>
      grant.permissions.has(permission) &&
      chain.some((scope) => sameScope(scope, grant.scope)),
  );
}

/** True when `permission` is held at any scope at all (menus, list pages). */
export function holdsAnywhere(
  grants: readonly Grant[],
  permission: PermissionKey,
): boolean {
  return grants.some((grant) => grant.permissions.has(permission));
}

/**
 * Where `permission` is held, as a filter for list queries: `global` means no
 * restriction; otherwise only rows belonging to these organizations or
 * competitions may be returned.
 */
export interface ScopeFilter {
  global: boolean;
  organizationIds: string[];
  competitionIds: string[];
}

export function scopeFilter(
  grants: readonly Grant[],
  permission: PermissionKey,
): ScopeFilter {
  const filter: ScopeFilter = {
    global: false,
    organizationIds: [],
    competitionIds: [],
  };
  for (const grant of grants) {
    if (!grant.permissions.has(permission)) continue;
    const { scope } = grant;
    if (scope.type === RoleScope.GLOBAL) filter.global = true;
    else if (scope.type === RoleScope.ORGANIZATION) filter.organizationIds.push(scope.id);
    else filter.competitionIds.push(scope.id);
  }
  filter.organizationIds = [...new Set(filter.organizationIds)];
  filter.competitionIds = [...new Set(filter.competitionIds)];
  return filter;
}
