import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { IDENTITY_PROVIDER } from './identity/identity-provider.interface';
import { createIdentityProvider } from './identity/identity-provider.factory';

/**
 * Global auth module. Registers the application-wide guards via APP_GUARD, IN ORDER:
 *   1. JwtAuthGuard — authentication (ADR-0038): sets request.user (OIDC JWT or X-User-Id shim).
 *   2. RolesGuard   — authorization (ADR-0040): enforces @Roles() AFTER request.user is populated.
 *
 * NestJS runs multiple APP_GUARD providers in registration order, so RolesGuard MUST be listed after
 * JwtAuthGuard or it would read an empty request.user. PrismaService is available globally
 * (PrismaModule is @Global), so JwtAuthGuard can inject it without importing PrismaModule here.
 *
 * It also provides the {@link IDENTITY_PROVIDER} — the IdP write-back seam (ADR-0043). A factory keyed
 * on IDENTITY_PROVIDER_TYPE (zitadel | generic-oidc; default zitadel) picks the implementation. This
 * is Phase-1 SCAFFOLDING: nothing injects it yet and authorization stays DB-first (the RolesGuard
 * never reads a role from the token); Phase 2 wires the Zitadel write-back through this token.
 *
 * See ADR-0038 (auth / JIT provisioning), ADR-0040 (RBAC roles) and ADR-0043 (Zitadel source-of-truth).
 */
@Global()
@Module({
  providers: [
    JwtAuthGuard,
    RolesGuard,
    // Authentication first: populate request.user.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Authorization second: enforce @Roles() against the now-populated request.user.
    { provide: APP_GUARD, useClass: RolesGuard },
    // IdP write-back provider (ADR-0043), selected by IDENTITY_PROVIDER_TYPE. Scaffolding for Phase 2.
    {
      provide: IDENTITY_PROVIDER,
      useFactory: () =>
        createIdentityProvider(process.env.IDENTITY_PROVIDER_TYPE),
    },
  ],
  exports: [JwtAuthGuard, RolesGuard, IDENTITY_PROVIDER],
})
export class AuthModule {}
