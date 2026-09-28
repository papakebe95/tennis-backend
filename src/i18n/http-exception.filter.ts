import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { t, type MessageKey } from './i18n.js';

// Nest's own default messages, for exceptions thrown without one (the JWT
// guard's bare `UnauthorizedException`, for instance).
const DEFAULT_MESSAGES: Record<string, MessageKey> = {
  Unauthorized: 'errors.http.unauthorized',
  Forbidden: 'errors.http.forbidden',
  'Not Found': 'errors.http.notFound',
  'Internal Server Error': 'errors.http.internal',
  'ThrottlerException: Too Many Requests': 'errors.http.tooManyRequests',
};

/**
 * Translates Nest's default messages and unexpected failures; every other
 * exception (the ones services throw with `t()` already applied) passes
 * through untouched.
 */
@Catch()
export class LocalizedExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionsHandler');

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();

    if (!(exception instanceof HttpException)) {
      this.logger.error(
        exception instanceof Error ? exception.stack : String(exception),
      );
      response
        .status(500)
        .json({ statusCode: 500, message: t('errors.http.unexpected') });
      return;
    }

    const status = exception.getStatus();
    const body = exception.getResponse();
    const payload: Record<string, unknown> =
      typeof body === 'string'
        ? { statusCode: status, message: body }
        : // Exceptions thrown with an object ({ message, code }) carry no
          // statusCode of their own; every error body has one.
          { statusCode: status, ...body };

    const key =
      typeof payload.message === 'string'
        ? DEFAULT_MESSAGES[payload.message]
        : undefined;
    if (key) payload.message = t(key);

    response.status(status).json(payload);
  }
}
