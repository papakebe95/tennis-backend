import {
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { UserStatus } from '@prisma/client';
import { pendingAccount } from './account-status.js';
import type { AuthenticatedUser } from './jwt.strategy.js';

const ALLOW_PENDING = 'auth:allowPending';

/**
 * Lets accounts still awaiting validation call this endpoint. Everything else
 * answers 403 ACCOUNT_PENDING to them.
 */
export const AllowPending = () => SetMetadata(ALLOW_PENDING, true);

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    await (super.canActivate(context) as Promise<boolean>);
    const user = context.switchToHttp().getRequest<{ user: AuthenticatedUser }>().user;
    if (user.status === UserStatus.PENDING) {
      const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!allowed) throw pendingAccount();
    }
    return true;
  }
}
