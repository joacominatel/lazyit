import { Module } from '@nestjs/common';
import { ConfigController } from './config.controller';
import { ConfigService } from './config.service';
import { PermissionsConfigService } from './permissions-config.service';
import { SetupCsrfService } from './setup-csrf.service';
import { SetupRateLimitGuard } from './setup-rate-limit.guard';
import { NotificationsModule } from '../notifications/notifications.module';

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
 *
 * Roles & Permissions v2 P5 (ADR-0046): also provides {@link PermissionsConfigService} — the editable
 * role→permission matrix backend behind GET/PUT /config/permissions and GET /config/my-permissions.
 * It injects the @Global PermissionResolverService (from AuthModule) to invalidate its cache on a
 * matrix edit and to resolve the caller's effective permissions.
 */
@Module({
  // NotificationsModule (exports NotificationsService): the sensitive-permission-change nudge
  // (ADR-0056 amendment / #852) — a matrix edit that widens MEMBER/VIEWER to a high-risk verb.
  imports: [NotificationsModule],
  controllers: [ConfigController],
  providers: [
    ConfigService,
    PermissionsConfigService,
    SetupCsrfService,
    SetupRateLimitGuard,
  ],
  exports: [ConfigService],
})
export class ConfigModule {}
