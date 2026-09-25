import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
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
};

/** Translates those default messages; every other exception passes through. */
@Catch(HttpException)
export class LocalizedHttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception.getStatus();
    const body = exception.getResponse();
    const payload: Record<string, unknown> =
      typeof body === 'string'
        ? { statusCode: status, message: body }
        : { ...body };

    const key =
      typeof payload.message === 'string'
        ? DEFAULT_MESSAGES[payload.message]
        : undefined;
    if (key) payload.message = t(key);

    response.status(status).json(payload);
  }
}
