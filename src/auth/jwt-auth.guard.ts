import {
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { UserStatus } from '@prisma/client';
import { passwordChangeRequired, pendingAccount } from './account-status.js';
import type { AuthenticatedUser } from './jwt.strategy.js';

const ALLOW_RESTRICTED = 'auth:allowRestricted';

/**
 * Lets restricted sessions call this endpoint: accounts still awaiting
 * validation, and accounts that must change a password an administrator
 * reset. Everything else answers 403 ACCOUNT_PENDING / PASSWORD_CHANGE_REQUIRED
 * to them.
 */
export const AllowRestricted = () => SetMetadata(ALLOW_RESTRICTED, true);

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    await (super.canActivate(context) as Promise<boolean>);
    const user = context.switchToHttp().getRequest<{ user: AuthenticatedUser }>().user;
    const restricted = user.status === UserStatus.PENDING || user.mustChangePassword;
    if (restricted) {
      const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_RESTRICTED, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!allowed) {
        throw user.mustChangePassword ? passwordChangeRequired() : pendingAccount();
      }
    }
    return true;
  }
}
