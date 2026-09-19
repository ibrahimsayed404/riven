import { BadRequestException, INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

/**
 * Everything that sits between Express and the controllers. Shared by main.ts
 * and the HTTP smoke test so what is tested is exactly what runs.
 */
export function configureApp(app: INestApplication): void {
  const configService = app.get(ConfigService);

  // Security headers with helmet defaults; the API serves JSON only, so the
  // content-security-policy defaults cost nothing.
  app.use(helmet());

  // CORS is an explicit allow-list. Default covers the local dashboards so a
  // dev never reaches for `enableCors()` with no arguments (allow everything).
  const corsOrigins = configService.get<string[]>('CORS_ORIGINS') ?? [];
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) =>
        new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: errors.flatMap((error) => Object.values(error.constraints ?? {})),
        }),
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
}
