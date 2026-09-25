import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { runWithLang } from './i18n.js';
import { LocalizedExceptionFilter } from './http-exception.filter.js';

const run = (exception: unknown, lang: 'en' | 'fr') => {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const host = { switchToHttp: () => ({ getResponse: () => ({ status }) }) };
  runWithLang(lang, () =>
    new LocalizedExceptionFilter().catch(exception, host as never),
  );
  return { status: status.mock.calls[0][0], body: json.mock.calls[0][0] };
};

describe('LocalizedExceptionFilter', () => {
  it('translates the bare default messages', () => {
    expect(run(new UnauthorizedException(), 'fr')).toEqual({
      status: 401,
      body: {
        statusCode: 401,
        message: 'Vous devez vous connecter pour faire cela',
      },
    });
    expect(run(new UnauthorizedException(), 'en').body.message).toBe(
      'Unauthorized',
    );
  });

  it('leaves messages a service already translated alone', () => {
    const body = run(new NotFoundException('Club introuvable'), 'fr').body;
    expect(body).toMatchObject({
      message: 'Club introuvable',
      error: 'Not Found',
    });
    expect(run(new ConflictException('x'), 'fr').status).toBe(409);
  });

  it('answers an unexpected failure with a translated 500, without leaking it', () => {
    const fr = run(new Error('connection refused to 10.0.0.5'), 'fr');
    expect(fr).toEqual({
      status: 500,
      body: {
        statusCode: 500,
        message: 'Une erreur est survenue, veuillez réessayer',
      },
    });
    expect(run(new Error('boom'), 'en').body.message).toBe(
      'Internal server error',
    );
  });
});
