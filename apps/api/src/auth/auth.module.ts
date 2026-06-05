import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PinoLogger } from 'nestjs-pino';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { PermissionResolverService } from './permission-resolver.service';
import { IDENTITY_PROVIDER } from './identity/identity-provider.interface';
import { createIdentityProvider } from './identity/identity-provider.factory';

/**
 * Global auth module. Registers the application-wide guards via APP_GUARD, IN ORDER:
 *   1. JwtAuthGuard — authentication (ADR-0038): sets request.user (OIDC JWT or X-User-Id shim).
 *   2. RolesGuard   — authorization (ADR-0040 → ADR-0046 P4): enforces @RequirePermission
 *      AFTER request.user is populated.
 *
 * NestJS runs multiple APP_GUARD providers in registration order, so RolesGuard MUST be listed after
 * JwtAuthGuard or it would read an empty request.user. PrismaService is available globally
 * (PrismaModule is @Global), so JwtAuthGuard and the {@link PermissionResolverService} can inject it
 * without importing PrismaModule here.
 *
 * Roles & Permissions v2 (ADR-0046 P4): the legacy coarse `@Roles` decorator + its dual-mode branch
 * have been RETIRED — RolesGuard now enforces the SINGLE fine-grained `@RequirePermission` primitive,
 * resolving the caller's permission set from the `RolePermission` DB rows via
 * {@link PermissionResolverService} (DB-first per INV-1 / INV-8). The resolver is provided here so the
 * guard can inject it; it stays in the SAME APP_GUARD slot/order, so registration is otherwise
 * unchanged.
 *
 * It also provides the {@link IDENTITY_PROVIDER} — the IdP write-back seam (ADR-0043). A factory keyed
 * on IDENTITY_PROVIDER_TYPE (zitadel | generic-oidc; default zitadel) picks the implementation. This
 * is Phase-1 SCAFFOLDING: nothing injects it yet and authorization stays DB-first (the RolesGuard
 * never reads a role from the token); Phase 2 wires the Zitadel write-back through this token.
 *
 * See ADR-0038 (auth / JIT provisioning), ADR-0040 (RBAC roles), ADR-0043 (Zitadel source-of-truth)
 * and ADR-0046 (Roles & Permissions v2).
 */
@Global()
@Module({
  providers: [
    JwtAuthGuard,
    PermissionResolverService,
    RolesGuard,
    // Authentication first: populate request.user.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Authorization second: enforce @RequirePermission against the now-populated request.user.
    { provide: APP_GUARD, useClass: RolesGuard },
    // IdP write-back provider (ADR-0043), selected by IDENTITY_PROVIDER_TYPE. The request-scoped
    // PinoLogger is injected and threaded into the Zitadel management client so its failure WARN
    // lines carry the failing edit's X-Request-Id / actor (ADR-0031), making a sustained 503
    // root-causable against the live stack (issue #219). A single PinoLogger is correct for this
    // startup singleton: it resolves the per-request child logger from AsyncLocalStorage at LOG time.
    {
      provide: IDENTITY_PROVIDER,
      useFactory: (logger: PinoLogger) =>
        createIdentityProvider(process.env.IDENTITY_PROVIDER_TYPE, logger),
      inject: [PinoLogger],
    },
  ],
  exports: [
    JwtAuthGuard,
    RolesGuard,
    PermissionResolverService,
    IDENTITY_PROVIDER,
  ],
})
export class AuthModule {}
