import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ZodValidationPipe } from 'nestjs-zod';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { LocationsModule } from './locations/locations.module';
import { AssetCategoriesModule } from './asset-categories/asset-categories.module';
import { AssetModelsModule } from './asset-models/asset-models.module';
import { AssetsModule } from './assets/assets.module';
import { AssetTagSchemeModule } from './asset-tag-scheme/asset-tag-scheme.module';
import { AssetAssignmentsModule } from './asset-assignments/asset-assignments.module';
import { ArticleCategoriesModule } from './article-categories/article-categories.module';
import { ArticlesModule } from './articles/articles.module';
import { ApplicationCategoriesModule } from './application-categories/application-categories.module';
import { ApplicationsModule } from './applications/applications.module';
import { AccessGrantsModule } from './access-grants/access-grants.module';
import { ConsumableCategoriesModule } from './consumable-categories/consumable-categories.module';
import { ConsumablesModule } from './consumables/consumables.module';
import { AssetHistoryModule } from './asset-history/asset-history.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { HealthModule } from './health/health.module';
import { CommonModule } from './common/common.module';
import { ConfigModule } from './config/config.module';
import { QueueModule } from './queue/queue.module';
import { ServiceAccountsModule } from './service-accounts/service-accounts.module';
import { WorkflowEngineModule } from './workflow-engine/workflow-engine.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SecretManagerModule } from './secret-manager/secret-manager.module';
import { SearchModule } from './search/search.module';
import { PrismaExceptionFilter } from './common/prisma-exception.filter';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { buildLoggerParams } from './logging/logging.config';

@Module({
  imports: [
    // Structured logging for the whole app (ADR-0031). First so it wraps every route.
    LoggerModule.forRoot(buildLoggerParams()),
    PrismaModule,
    // Global auth guard (ADR-0038): JwtAuthGuard runs on every request.
    // AUTH_MODE=shim → reads X-User-Id; default → validates OIDC Bearer JWT + JIT provisions User.
    AuthModule,
    // Global cross-cutting providers (ActorService — resolves actor id from User entity, ADR-0038).
    CommonModule,
    // Async workers foundation (ADR-0053): the shared BullMQ connection to Valkey (REDIS_URL).
    // Global so feature modules can register their queues. Powers the async .docx import (SEC-002).
    QueueModule,
    // Global cross-cutting search (ADR-0035): exports SearchService for fire-and-forget index sync,
    // hosts GET /search. No-ops when MEILI_HOST is unset.
    SearchModule,
    // Operational health probes (@Public() /health/live + /health/ready). Hand-rolled, no terminus.
    HealthModule,
    // In-app first-run setup (ADR-0043 Phase 3): @Public() GET /config/status + the idempotent,
    // CSRF + rate-limited POST /config/setup that bootstraps the first ADMIN. No migration.
    ConfigModule,
    AssetHistoryModule,
    UsersModule,
    LocationsModule,
    AssetCategoriesModule,
    AssetModelsModule,
    AssetsModule,
    // Configurable asset-tag scheme (ADR-0063, #363): the first instance-config entity. Hosts
    // GET/PUT /config/asset-tag-scheme and exports AssetTagSchemeService for in-create allocation.
    AssetTagSchemeModule,
    AssetAssignmentsModule,
    ArticleCategoriesModule,
    ArticlesModule,
    ApplicationCategoriesModule,
    ApplicationsModule,
    AccessGrantsModule,
    ConsumableCategoriesModule,
    ConsumablesModule,
    // Read-only cross-pillar aggregation for the web dashboard (CTO Round 1). Additive — no schema.
    DashboardModule,
    // Service Accounts management (ADR-0048): ADMIN-gated /service-accounts CRUD + token lifecycle.
    // The SA authentication branch itself lives in AuthModule's JwtAuthGuard.
    ServiceAccountsModule,
    // Applications Workflow Engine CORE (ADR-0054 / epic #248): the run orchestrator + BullMQ worker
    // + the AccessGrant → workflow transactional outbox + the run/manual-task/definition endpoints.
    // Activates SecretService's fail-loud onModuleInit — the app requires WORKFLOW_SECRET_KEY at boot.
    WorkflowEngineModule,
    // In-app notification bell (ADR-0056): the four poll endpoints (gated notification:read), the
    // 90-day retention sweep, and the exported NotificationsService the post-commit emitters use.
    NotificationsModule,
    // Zero-knowledge Secret Manager (ADR-0061, #366): the ciphertext-custodian backend — keypair +
    // vault/item/membership CRUD + KB-chip resolution. Two-layer authz (RBAC secret:read/secret:manage
    // ⟂ per-vault crypto membership), human-only. The server stores wrapped blobs + ciphertext and can
    // NEVER decrypt a value (INV-10): no reveal(), no env key, no cipher anywhere in the module.
    SecretManagerModule,
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
