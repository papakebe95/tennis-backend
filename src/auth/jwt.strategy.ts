import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import type { UserStatus } from '@prisma/client';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { t } from '../i18n/i18n.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertMaySignIn } from './account-status.js';

export interface JwtAccessPayload {
  sub: string;
  email: string;
  /** User.tokenVersion when issued; absent on tokens from before it existed. */
  ver?: number;
}

export interface AuthenticatedUser {
  userId: string;
  email: string;
  status: UserStatus;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_ACCESS_SECRET')!,
    });
  }

  /**
   * The token alone is not trusted: the account is re-read on every request
   * so a suspension or a password change takes effect immediately instead of
   * when the 15-minute token expires.
   */
  async validate(payload: JwtAccessPayload): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, status: true, tokenVersion: true },
    });
    if (!user) throw new UnauthorizedException();
    assertMaySignIn(user.status, true);
    if ((payload.ver ?? 0) !== user.tokenVersion) {
      throw new UnauthorizedException({
        message: t('errors.auth.sessionRevoked'),
        code: 'SESSION_REVOKED',
      });
    }
    return { userId: user.id, email: user.email, status: user.status };
  }
}
