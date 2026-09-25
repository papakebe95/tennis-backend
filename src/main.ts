import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import { AppModule } from './app.module.js';
import { LocalizedHttpExceptionFilter } from './i18n/http-exception.filter.js';
import { langMiddleware } from './i18n/i18n.js';
import { createValidationPipe } from './i18n/validation.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.enableCors();
  // Reads the `lang` header (en | fr) so errors and notifications are
  // translated for the caller.
  app.use(langMiddleware);
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new LocalizedHttpExceptionFilter());

  // Serves files saved by UploadsService (local disk) back over HTTP, e.g.
  // uploads/clubs/<uuid>.jpg -> GET /uploads/clubs/<uuid>.jpg
  app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads/' });

  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
