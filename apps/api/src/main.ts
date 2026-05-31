import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { validateBootConfig } from './auth/boot-config';

async function bootstrap() {
  // Fail-loud config (ops-boot integrity): validate before NestFactory.create so a misconfigured
  // server refuses to start with a CRITICAL log, instead of booting half-wired. See boot-config.ts.
  validateBootConfig();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  // Route Nest's own logs through Pino (structured logging — ADR-0031). bufferLogs holds the
  // bootstrap logs until the Pino logger is attached, so nothing is lost or double-formatted.
  app.useLogger(app.get(Logger));
  // Ensure PrismaService.onModuleDestroy runs on SIGTERM/SIGINT (graceful $disconnect).
  app.enableShutdownHooks();

  // CORS for the web app. Origin is read from WEB_ORIGIN (default: the Next.js dev server)
  // so it is never hardcoded. credentials:true is set ahead of cookie/session auth (deferred,
  // ADR-0016); with credentials the origin must be explicit, never "*". allowedHeaders is left
  // unset so cors reflects the requested headers (covers Content-Type, Authorization, …).
  // exposedHeaders surfaces X-Request-Id (ADR-0031) to the browser so the client can quote it in
  // error UX — cross-origin responses hide non-safelisted headers from JS unless exposed.
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    exposedHeaders: ['X-Request-Id'],
    credentials: true,
  });

  // OpenAPI: schemas come from the zod DTOs; cleanupOpenApiDoc is required for correct output.
  // Swagger UI at /api/docs, raw OpenAPI JSON at /api/docs-json. See ADR-0018.
  // addBearerAuth() surfaces the Authorization: Bearer <token> scheme in the Swagger UI (ADR-0038).
  const config = new DocumentBuilder()
    .setTitle('lazyit API')
    .setDescription(
      'Self-hosted IT asset, access, ticket and knowledge-base API.',
    )
    .setVersion('0.1')
    .addBearerAuth()
    .build();
  const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, config));
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(process.env.PORT ?? 3001);
}

// Only boot when run as the entry point (e.g. `nest start`); importing this module (config specs)
// must not start the server. Under ts-jest (CommonJS) `require.main` is the jest runner, not main.ts.
if (require.main === module) {
  void bootstrap();
}
