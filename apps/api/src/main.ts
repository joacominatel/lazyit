import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap() {
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
  const config = new DocumentBuilder()
    .setTitle('lazyit API')
    .setDescription(
      'Self-hosted IT asset, access, ticket and knowledge-base API.',
    )
    .setVersion('0.1')
    .build();
  const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, config));
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(process.env.PORT ?? 3001);
}
void bootstrap();
