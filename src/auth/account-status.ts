import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import { t, type MessageKey } from '../i18n/i18n.js';

// Machine-readable codes the clients switch on; the message is for people.
const BLOCKED: Partial<Record<UserStatus, { code: string; key: MessageKey }>> = {
  [UserStatus.SUSPENDED]: { code: 'ACCOUNT_SUSPENDED', key: 'errors.auth.accountSuspended' },
  [UserStatus.DISABLED]: { code: 'ACCOUNT_DISABLED', key: 'errors.auth.accountDisabled' },
  [UserStatus.REJECTED]: { code: 'ACCOUNT_REJECTED', key: 'errors.auth.accountRejected' },
};

/**
 * Throws when an account may not hold a session. PENDING accounts may: they
 * sign in to a restricted area (see AllowRestricted) to follow their request.
 *
 * `asSession` answers 401 instead of 403 — used on already-issued tokens, so
 * a client treats it as "session over" and signs out.
 */
export function assertMaySignIn(status: UserStatus, asSession = false): void {
  const blocked = BLOCKED[status];
  if (!blocked) return;
  const body = { message: t(blocked.key), code: blocked.code };
  throw asSession ? new UnauthorizedException(body) : new ForbiddenException(body);
}

export const passwordChangeRequired = () =>
  new ForbiddenException({
    message: t('errors.auth.passwordChangeRequired'),
    code: 'PASSWORD_CHANGE_REQUIRED',
  });

export const pendingAccount = () =>
  new ForbiddenException({ message: t('errors.auth.accountPending'), code: 'ACCOUNT_PENDING' });
