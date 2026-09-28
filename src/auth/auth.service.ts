import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { toInternationalPhone } from '../common/utils/phone.js';
import { AuditService } from '../audit/audit.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { assertMaySignIn } from './account-status.js';
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
    private readonly audit: AuditService,
  ) {}

  /**
   * Creates an account and signs it in. Players are ACTIVE at once. A
   * back-office `applicant` starts PENDING, and its access request is written
   * by `applicant.inTransaction` together with the account, so neither
   * exists without the other.
   */
  async register(
    dto: RegisterDto,
    applicant?: { inTransaction: (tx: Prisma.TransactionClient, userId: string) => Promise<void> },
  ): Promise<TokenPair> {
    const msisdn = toInternationalPhone(dto.msisdn, this.callingCode());
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

    const create = (db: Pick<Prisma.TransactionClient, 'user'>) =>
      db.user.create({
        data: {
          email: dto.email,
          passwordHash,
          firstname: dto.firstname,
          lastname: dto.lastname,
          msisdn,
          ...(applicant ? { status: UserStatus.PENDING } : {}),
        },
      });

    let user;
    try {
      user = applicant
        ? await this.prisma.$transaction(async (tx) => {
            const created = await create(tx);
            await applicant.inTransaction(tx, created.id);
            return created;
          })
        : await create(this.prisma);
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

    return this.issueTokenPair(user);
  }

  /** Signs in with a phone number or an email (`identifier`, or legacy `email`). */
  async login(dto: LoginDto): Promise<TokenPair> {
    const identifier = (dto.identifier ?? dto.email ?? '').trim();
    if (!identifier) {
      throw new BadRequestException(t('errors.auth.identifierRequired'));
    }
    const user = await this.findByIdentifier(identifier);
    const invalid = () =>
      new UnauthorizedException({
        message: t('errors.auth.invalidCredentials'),
        code: 'INVALID_CREDENTIALS',
      });
    if (!user) throw invalid();

    const passwordMatches = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );
    if (!passwordMatches) throw invalid();

    // Only after the password is proven, so status can't be probed.
    assertMaySignIn(user.status);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return this.issueTokenPair(user);
  }

  private findByIdentifier(identifier: string) {
    if (identifier.includes('@')) {
      return this.prisma.user.findFirst({
        where: { email: { equals: identifier, mode: 'insensitive' } },
      });
    }
    // Stored numbers are international ("+221…"); people often type the
    // local form ("77 000 00 01") or omit the "+".
    const msisdn = toInternationalPhone(identifier, this.callingCode());
    return msisdn ? this.prisma.user.findUnique({ where: { msisdn } }) : null;
  }

  private callingCode(): string {
    return this.configService.get<string>('DEFAULT_CALLING_CODE', '221');
  }

  /**
   * Changes the password, ends every other session (refresh tokens revoked,
   * older access tokens rejected via passwordChangedAt) and returns a fresh
   * token pair for the current one.
   */
  async changePassword(userId: string, dto: ChangePasswordDto): Promise<TokenPair> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    if (!(await bcrypt.compare(dto.currentPassword, user.passwordHash))) {
      throw new BadRequestException({
        message: t('errors.auth.wrongPassword'),
        code: 'WRONG_PASSWORD',
      });
    }
    if (await bcrypt.compare(dto.newPassword, user.passwordHash)) {
      throw new BadRequestException(t('errors.auth.samePassword'));
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    const updated = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          passwordChangedAt: new Date(),
          mustChangePassword: false,
          tokenVersion: { increment: 1 },
        },
      });
      await tx.refreshToken.updateMany({
        where: { userId, revoked: false },
        data: { revoked: true },
      });
      await this.audit.record(
        {
          actorId: userId,
          action: 'user.password.changed',
          entityType: 'User',
          entityId: userId,
        },
        tx,
      );
      return saved;
    });
    return this.issueTokenPair(updated);
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
    assertMaySignIn(user.status);

    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revoked: true },
    });

    return this.issueTokenPair(user);
  }

  async logout(rawToken: string): Promise<void> {
    const { record } = await this.validateRawRefreshToken(rawToken);
    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revoked: true },
    });
  }

  private async issueTokenPair(user: {
    id: string;
    email: string;
    tokenVersion: number;
  }): Promise<TokenPair> {
    const userId = user.id;
    const accessToken = await this.jwtService.signAsync(
      { sub: userId, email: user.email, ver: user.tokenVersion },
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
