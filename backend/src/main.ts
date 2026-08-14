import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
// compression is a CommonJS `export =` package; this form avoids a broken `.default` call at runtime.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import compression = require('compression');
import helmet from 'helmet';

import { AppModule } from './app.module';
import { ApplicationExceptionFilter } from './common/errors';

const DEVELOPMENT_ORIGINS = [
  'http://localhost:3001',
  // The admin console in Docker: 5454 is the published container port
  // (`WEB_PORT`), 5455 a local production build beside it.
  'http://localhost:5454',
  'http://localhost:5455',
  // The console's dev server (`WEB_DEV_PORT`, web/scripts/dev.mjs). Same API and
  // same session cookies, so it fails at the CORS preflight rather than anywhere
  // informative if this is missing — the browser reports a missing
  // Access-Control-Allow-Origin on /admin/profile, which reads like a backend
  // misconfiguration.
  'http://localhost:5456',
  'http://localhost:8081',
  'http://localhost:8082',
  'http://localhost:19006',
];

export function allowedCorsOrigins(environment: NodeJS.ProcessEnv = process.env) {
  const configured = [
    environment.CORS_ALLOWED_ORIGINS ?? environment.CORS_ORIGINS,
    environment.MOBILE_APP_ORIGIN,
    environment.WEB_APP_ORIGIN,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .flatMap((value) => value.split(','))
    .map((origin) => origin.trim())
    .filter(Boolean);
  const candidates =
    environment.NODE_ENV === 'production' ? configured : [...DEVELOPMENT_ORIGINS, ...configured];
  const origins = [...new Set(candidates)];
  if (environment.NODE_ENV === 'production' && origins.includes('*'))
    throw new Error('CORS wildcard origins are not allowed with credentialed production requests.');
  return origins;
}

export function configureApplication(app: Awaited<ReturnType<typeof NestFactory.create>>) {
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.use(
    compression({
      threshold: 1_024,
      filter: (request, response) => {
        const type = String(response.getHeader('Content-Type') ?? '');
        if (/^(image|video)\//i.test(type) || /^application\/pdf/i.test(type)) return false;
        return compression.filter(request, response);
      },
    }),
  );
  app.use(helmet());
  app.enableCors({
    origin: allowedCorsOrigins(),
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new ApplicationExceptionFilter());
  app.enableShutdownHooks();
}

async function bootstrap() {
  // rawBody keeps the exact request bytes available for webhook signature checks.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  configureApplication(app);
  // Swagger is a development convenience. During remote beta the backend is
  // publicly reachable through ngrok, so exposing the full API surface and DTO
  // shapes is opt-in rather than automatic.
  const swaggerEnabled =
    process.env.NODE_ENV !== 'production' &&
    (process.env.APP_ENV !== 'remote-beta' || process.env.ENABLE_SWAGGER === 'true');
  if (swaggerEnabled) {
    const config = new DocumentBuilder()
      .setTitle('TexasRenters Inspection API')
      .setDescription('Mock-first REST API foundation. AI findings always require human review.')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));
  }
  // Bind every interface: inside a container, listening only on loopback makes
  // the service unreachable from the Docker network and therefore from ngrok.
  await app.listen(process.env.PORT ?? 3000, process.env.HOST ?? '0.0.0.0');
  const server = app.getHttpServer() as {
    setTimeout(value: number): void;
    keepAliveTimeout: number;
    headersTimeout: number;
  };
  server.setTimeout(Number(process.env.HTTP_REQUEST_TIMEOUT_MS ?? 30_000));
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
}

if (require.main === module) void bootstrap();
