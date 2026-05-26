import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ZodValidationPipe } from 'nestjs-zod';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { LocationsModule } from './locations/locations.module';
import { AssetCategoriesModule } from './asset-categories/asset-categories.module';
import { AssetModelsModule } from './asset-models/asset-models.module';
import { AssetsModule } from './assets/assets.module';
import { AssetAssignmentsModule } from './asset-assignments/asset-assignments.module';
import { ArticleCategoriesModule } from './article-categories/article-categories.module';
import { ArticlesModule } from './articles/articles.module';
import { ApplicationCategoriesModule } from './application-categories/application-categories.module';
import { ApplicationsModule } from './applications/applications.module';
import { AccessGrantsModule } from './access-grants/access-grants.module';
import { AssetHistoryModule } from './asset-history/asset-history.module';
import { CommonModule } from './common/common.module';
import { PrismaExceptionFilter } from './common/prisma-exception.filter';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { buildLoggerParams } from './logging/logging.config';

@Module({
  imports: [
    // Structured logging for the whole app (ADR-0031). First so it wraps every route.
    LoggerModule.forRoot(buildLoggerParams()),
    PrismaModule,
    // Global cross-cutting providers (ActorService — the X-User-Id shim resolver, ADR-0033).
    CommonModule,
    AssetHistoryModule,
    UsersModule,
    LocationsModule,
    AssetCategoriesModule,
    AssetModelsModule,
    AssetsModule,
    AssetAssignmentsModule,
    ArticleCategoriesModule,
    ArticlesModule,
    ApplicationCategoriesModule,
    ApplicationsModule,
    AccessGrantsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Global zod validation for every @Body typed as a createZodDto class (ADR-0018).
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    // Prisma known-error -> HTTP mapping (P2002->409, P2003/P2023->400, P2025->404). No longer a
    // competing global filter: it is a plain provider injected into AllExceptionsFilter (ADR-0031).
    PrismaExceptionFilter,
    // Single global exception filter: logs >=500 faults with their stack (CRITICAL) then delegates
    // response shaping (Prisma errors -> PrismaExceptionFilter, the rest -> Nest default). ADR-0031.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
