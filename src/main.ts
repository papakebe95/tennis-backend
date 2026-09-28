import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { join } from 'node:path';
import { AppModule } from './app.module.js';
import { requestContextMiddleware } from './common/request-context.js';
import { LocalizedExceptionFilter } from './i18n/http-exception.filter.js';
import { langMiddleware } from './i18n/i18n.js';
import { createValidationPipe } from './i18n/validation.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Behind a proxy (Railway), trust it for the client IP used by the audit
  // log and rate limiting.
  if (process.env.TRUST_PROXY) {
    app.set('trust proxy', Number(process.env.TRUST_PROXY) || true);
  }

  // Browsers are limited to the listed origins (the back-office) and may send
  // cookies; with no list every origin is allowed without credentials, as
  // before. Native mobile clients are not subject to CORS.
  const corsOrigins = process.env.CORS_ORIGINS?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors(
    corsOrigins?.length ? { origin: corsOrigins, credentials: true } : undefined,
  );
  app.use(cookieParser());
  app.use(requestContextMiddleware);
  // Reads the `lang` header (en | fr) so errors and notifications are
  // translated for the caller.
  app.use(langMiddleware);
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new LocalizedExceptionFilter());

  // Serves files saved by UploadsService (local disk) back over HTTP, e.g.
  // uploads/clubs/<uuid>.jpg -> GET /uploads/clubs/<uuid>.jpg
  app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads/' });

  if (process.env.NODE_ENV !== 'production' || process.env.API_DOCS === 'true') {
    const config = new DocumentBuilder()
      .setTitle('Tennis API')
      .setDescription('Player (mobile) and back-office (/admin) endpoints')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, config));
  }

  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
