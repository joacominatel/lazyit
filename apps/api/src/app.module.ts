import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
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
import { PrismaExceptionFilter } from './common/prisma-exception.filter';

@Module({
  imports: [
    PrismaModule,
    UsersModule,
    LocationsModule,
    AssetCategoriesModule,
    AssetModelsModule,
    AssetsModule,
    AssetAssignmentsModule,
    ArticleCategoriesModule,
    ArticlesModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Global zod validation for every @Body typed as a createZodDto class (ADR-0018).
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    // Map Prisma known errors to 4xx (P2002->409, P2003->400, P2025->404).
    { provide: APP_FILTER, useClass: PrismaExceptionFilter },
  ],
})
export class AppModule {}
