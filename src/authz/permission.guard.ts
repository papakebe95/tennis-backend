import {
  applyDecorators,
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../auth/jwt.strategy.js';
import { AuthzService, forbidden, type ResourceType } from './authz.service.js';
import type { PermissionKey } from './permissions.js';
import { holdsAnywhere, type Grant } from './scope.js';

export interface PermissionRequirement {
  permission: PermissionKey;
  /**
   * Anchor the check on this resource: its id is read from the route param
   * `param` (default "id") and its owning scope from the database.
   */
  resource?: ResourceType;
  param?: string;
  /**
   * Pass when the permission is held at any scope; the handler then narrows
   * results with `scopeFilter(grants, permission)`. For list endpoints.
   */
  anywhere?: boolean;
}

const REQUIREMENT = 'authz:requirement';

type AuthzRequest = {
  user?: AuthenticatedUser;
  grants?: Grant[];
  params: Record<string, string>;
};

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authz: AuthzService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.getAllAndOverride<PermissionRequirement>(
      REQUIREMENT,
      [context.getHandler(), context.getClass()],
    );
    if (!requirement) return true;

    const request = context.switchToHttp().getRequest<AuthzRequest>();
    if (!request.user) throw new UnauthorizedException();
    request.grants ??= await this.authz.loadGrants(request.user.userId);

    const { permission, resource, param = 'id', anywhere } = requirement;
    // Checked before touching the resource, so someone without the
    // permission anywhere can't probe which ids exist (403, not 404).
    if (!holdsAnywhere(request.grants, permission)) throw forbidden();
    if (anywhere) return true;

    const chain = resource
      ? await this.authz.scopeChain(resource, request.params[param])
      : undefined; // global only
    this.authz.assert(request.grants, permission, chain);
    return true;
  }
}

/**
 * Requires authentication and `permission` — at the global scope, on the
 * resource named by a route param, or anywhere (see PermissionRequirement).
 */
export const Authorize = (
  permission: PermissionKey,
  options: Omit<PermissionRequirement, 'permission'> = {},
) =>
  applyDecorators(
    SetMetadata(REQUIREMENT, { permission, ...options }),
    UseGuards(JwtAuthGuard, PermissionGuard),
  );

/** The caller's grants, as loaded by PermissionGuard. */
export const CurrentGrants = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Grant[] =>
    ctx.switchToHttp().getRequest<AuthzRequest>().grants ?? [],
);
