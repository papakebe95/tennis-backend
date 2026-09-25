import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { normalizePhone } from '../common/utils/phone.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { t } from '../i18n/i18n.js';

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const BCRYPT_ROUNDS = 10;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async register(dto: RegisterDto): Promise<TokenPair> {
    const msisdn = normalizePhone(dto.msisdn);
    if (!msisdn) {
      throw new BadRequestException(t('errors.phone.invalid'));
    }

    const [existingEmail, existingMsisdn, existingExtraPhone] =
      await Promise.all([
        this.prisma.user.findUnique({ where: { email: dto.email } }),
        this.prisma.user.findUnique({ where: { msisdn } }),
        this.prisma.userPhone.findUnique({ where: { number: msisdn } }),
      ]);
    if (existingEmail) {
      throw new ConflictException(t('errors.auth.emailTaken'));
    }
    // Also checked against UserPhone: a number already saved as someone
    // else's secondary number can't become a new account's primary one.
    if (existingMsisdn || existingExtraPhone) {
      throw new ConflictException(t('errors.auth.phoneTaken'));
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    let user;
    try {
      user = await this.prisma.user.create({
        data: {
          email: dto.email,
          passwordHash,
          firstname: dto.firstname,
          lastname: dto.lastname,
          msisdn,
        },
      });
    } catch (error) {
      // Safety net for a race: two requests can both pass the checks above
      // and then collide on the DB's unique constraint. Same message either
      // way — the client can't tell which field lost the race, and doesn't
      // need to.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(t('errors.auth.emailOrPhoneTaken'));
      }
      throw error;
    }

    return this.issueTokenPair(user.id, user.email);
  }

  async login(dto: LoginDto): Promise<TokenPair> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (!user) {
      throw new UnauthorizedException(t('errors.auth.invalidCredentials'));
    }

    const passwordMatches = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );
    if (!passwordMatches) {
      throw new UnauthorizedException(t('errors.auth.invalidCredentials'));
    }

    return this.issueTokenPair(user.id, user.email);
  }

  /**
   * Rotates a refresh token: validates the presented token, revokes it, and
   * issues a brand new access/refresh pair.
   */
  async refreshToken(rawToken: string): Promise<TokenPair> {
    const { record } = await this.validateRawRefreshToken(rawToken);

    const user = await this.prisma.user.findUnique({
      where: { id: record.userId },
    });
    if (!user) {
      throw new UnauthorizedException(t('errors.auth.invalidRefreshToken'));
    }

    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revoked: true },
    });

    return this.issueTokenPair(user.id, user.email);
  }

  async logout(rawToken: string): Promise<void> {
    const { record } = await this.validateRawRefreshToken(rawToken);
    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revoked: true },
    });
  }

  private async issueTokenPair(
    userId: string,
    email: string,
  ): Promise<TokenPair> {
    const accessToken = await this.jwtService.signAsync(
      { sub: userId, email },
      {
        secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
        expiresIn: ACCESS_TOKEN_TTL,
      },
    );

    const refreshToken = await this.createRefreshToken(userId);

    return { accessToken, refreshToken };
  }

  /**
   * Creates an opaque refresh token of the form `<recordId>.<secret>`.
   * Only the bcrypt hash of `pepper(secret)` is stored, never the raw
   * secret itself; `recordId` is just a lookup key (not secret) that lets
   * `validateRawRefreshToken` find the right row instead of bcrypt-comparing
   * against every stored hash. `JWT_REFRESH_SECRET` is mixed in as a
   * server-side pepper so a stolen database dump alone isn't enough to
   * forge a valid refresh token.
   */
  private async createRefreshToken(userId: string): Promise<string> {
    const secret = randomBytes(32).toString('base64url');
    const tokenHash = await bcrypt.hash(this.pepper(secret), BCRYPT_ROUNDS);

    const record = await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    });

    return `${record.id}.${secret}`;
  }

  private async validateRawRefreshToken(rawToken: string) {
    const separatorIndex = rawToken.indexOf('.');
    if (separatorIndex === -1) {
      throw new UnauthorizedException(t('errors.auth.invalidRefreshToken'));
    }

    const recordId = rawToken.slice(0, separatorIndex);
    const secret = rawToken.slice(separatorIndex + 1);

    const record = await this.prisma.refreshToken.findUnique({
      where: { id: recordId },
    });

    if (!record || record.revoked || record.expiresAt < new Date()) {
      throw new UnauthorizedException(t('errors.auth.invalidRefreshToken'));
    }

    const matches = await bcrypt.compare(
      this.pepper(secret),
      record.tokenHash,
    );
    if (!matches) {
      throw new UnauthorizedException(t('errors.auth.invalidRefreshToken'));
    }

    return { record };
  }

  private pepper(secret: string): string {
    const refreshSecret = this.configService.get<string>(
      'JWT_REFRESH_SECRET',
      '',
    );
    return `${secret}:${refreshSecret}`;
  }
}
