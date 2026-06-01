import { Module } from '@nestjs/common';
import { ConfigController } from './config.controller';
import { ConfigService } from './config.service';
import { SetupCsrfService } from './setup-csrf.service';
import { SetupRateLimitGuard } from './setup-rate-limit.guard';

/**
 * ConfigModule — the in-app first-run setup surface (ADR-0043 Phase 3, roadmap PR 3.2).
 *
 * Provides `GET /config/status` (@Public first-run detection), `GET /config/csrf` and
 * `POST /config/setup` (the idempotent, CSRF + rate-limited first-ADMIN bootstrap). NO migration:
 * "configured" is derived from whether any ADMIN exists, and integrationMode/devMode from env.
 *
 * Depends only on globals: PrismaModule (@Global) for the ADMIN count + create, SearchModule
 * (@Global) for the search index sync, and the AuthModule's IDENTITY_PROVIDER token (@Global) for
 * the optional Zitadel mirror. The CSRF service + rate-limit guard are module-local.
 */
@Module({
  controllers: [ConfigController],
  providers: [ConfigService, SetupCsrfService, SetupRateLimitGuard],
  exports: [ConfigService],
})
export class ConfigModule {}
