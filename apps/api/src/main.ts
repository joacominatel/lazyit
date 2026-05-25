import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Ensure PrismaService.onModuleDestroy runs on SIGTERM/SIGINT (graceful $disconnect).
  app.enableShutdownHooks();

  // OpenAPI: schemas come from the zod DTOs; cleanupOpenApiDoc is required for correct output.
  // Swagger UI at /api/docs, raw OpenAPI JSON at /api/docs-json. See ADR-0018.
  const config = new DocumentBuilder()
    .setTitle('lazyit API')
    .setDescription('Self-hosted IT asset, access, ticket and knowledge-base API.')
    .setVersion('0.1')
    .build();
  const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, config));
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(process.env.PORT ?? 3001);
}
void bootstrap();
