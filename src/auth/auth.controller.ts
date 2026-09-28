import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { CookieOptions, Request, Response } from 'express';
import { AuthzService } from '../authz/authz.service.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { t } from '../i18n/i18n.js';
import { AuthService, TokenPair } from './auth.service.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { RefreshTokenDto } from './dto/refresh-token.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { AllowPending, JwtAuthGuard } from './jwt-auth.guard.js';
import type { AuthenticatedUser } from './jwt.strategy.js';

// Browser clients (the back-office) send `X-Auth-Mode: cookie`: their refresh
// token then lives in an httpOnly cookie that page scripts can't read, and
// only the access token is returned in the body. Mobile clients keep getting
// both tokens in the body. The custom header also forces a CORS preflight,
// so another site can't trigger a cookie refresh.
const REFRESH_COOKIE = 'tb_refresh';
const REFRESH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const usesCookie = (req: Request) =>
  req.headers['x-auth-mode']?.toString().toLowerCase() === 'cookie';

type AuthResponse = TokenPair | { accessToken: string };

@Controller('auth')
@UseGuards(ThrottlerGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly authz: AuthzService,
    private readonly config: ConfigService,
  ) {}

  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    return this.respond(req, res, await this.authService.register(dto));
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    return this.respond(req, res, await this.authService.login(dto));
  }

  @Post('refresh-token')
  @HttpCode(HttpStatus.OK)
  async refreshToken(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    try {
      const pair = await this.authService.refreshToken(this.presentedToken(dto, req));
      return this.respond(req, res, pair);
    } catch (error) {
      if (usesCookie(req)) res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @AllowPending()
  async logout(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    if (usesCookie(req)) res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
    await this.authService.logout(this.presentedToken(dto, req));
  }

  /** Who is signed in, and every role they hold with its scope. */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @AllowPending()
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.authz.describeAccess(user.userId);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @AllowPending()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    return this.respond(req, res, await this.authService.changePassword(user.userId, dto));
  }

  private presentedToken(dto: RefreshTokenDto, req: Request): string {
    const cookies = req.cookies as Record<string, string> | undefined;
    const token = dto.refreshToken ?? (usesCookie(req) ? cookies?.[REFRESH_COOKIE] : undefined);
    if (!token) {
      throw new UnauthorizedException(t('errors.auth.invalidRefreshToken'));
    }
    return token;
  }

  private respond(req: Request, res: Response, pair: TokenPair): AuthResponse {
    if (!usesCookie(req)) return pair;
    res.cookie(REFRESH_COOKIE, pair.refreshToken, {
      ...this.cookieOptions(),
      maxAge: REFRESH_COOKIE_MAX_AGE_MS,
    });
    return { accessToken: pair.accessToken };
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.config.get<string>('NODE_ENV') === 'production',
      path: '/',
    };
  }
}
