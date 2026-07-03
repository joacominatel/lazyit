import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PinoLogger } from 'nestjs-pino';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { MustChangePasswordGuard } from './must-change-password.guard';
import { PermissionResolverService } from './permission-resolver.service';
import { IDENTITY_PROVIDER } from './identity/identity-provider.interface';
import { createIdentityProvider } from './identity/identity-provider.factory';
import { LocalCredentialService } from './local/local-credential.service';
import { LocalProvisioningService } from './local/local-provisioning.service';

/**
 * Global auth module. Registers the application-wide guards via APP_GUARD, IN ORDER:
 *   1. JwtAuthGuard           — authentication (ADR-0038): sets request.user (OIDC JWT / local session /
 *      X-User-Id shim).
 *   2. MustChangePasswordGuard — forced password change (ADR-0086 §F4): in local mode, walls off a
 *      mustChangePassword=true human from every non-exempt route (403 PASSWORD_CHANGE_REQUIRED) BEFORE
 *      authorization. A no-op outside local mode / for non-flagged users / public + exempt routes.
 *   3. RolesGuard             — authorization (ADR-0040 → ADR-0046 P4): enforces @RequirePermission
 *      AFTER request.user is populated.
 *
 * NestJS runs multiple APP_GUARD providers in registration order, so MustChangePasswordGuard and RolesGuard
 * MUST be listed after JwtAuthGuard or they would read an empty request.user. PrismaService is available globally
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
    // Forced-change gate (ADR-0086 §F4): blocks a mustChangePassword=true human from every non-exempt
    // route (local mode only). Provided so it can be an APP_GUARD; see the ordered registration below.
    MustChangePasswordGuard,
    // Local (first-party) credential + session primitives (ADR-0086 §3). Provided here (and exported) so
    // BOTH the guard's handleLocal branch and the LocalAuthModule's LoginService inject the SAME instance.
    LocalCredentialService,
    // Local provisioning primitive (ADR-0086 §5, F1c): set-password / temp-password, reused by
    // ConfigService.setup + UsersService.create/requestPasswordReset in their local branches. Global so
    // both feature modules inject it without importing the local module.
    LocalProvisioningService,
    // Authentication first: populate request.user.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Forced password change (ADR-0086 §F4) second: a local user who still owes a one-time-credential
    // change is walled off from every non-exempt route (403 PASSWORD_CHANGE_REQUIRED) BEFORE any
    // authorization runs. Reads request.user set above; a no-op outside local mode / for non-flagged users.
    { provide: APP_GUARD, useClass: MustChangePasswordGuard },
    // Authorization third: enforce @RequirePermission against the now-populated request.user.
    { provide: APP_GUARD, useClass: RolesGuard },
    // IdP write-back provider (ADR-0043), selected by IDENTITY_PROVIDER_TYPE. The request-scoped
    // PinoLogger is injected and threaded into the Zitadel management client so its failure WARN
    // lines carry the failing edit's X-Request-Id / actor (ADR-0031), making a sustained 503
    // root-causable against the live stack (issue #219). A single PinoLogger is correct for this
    // startup singleton: it resolves the per-request child logger from AsyncLocalStorage at LOG time.
    {
      provide: IDENTITY_PROVIDER,
      // AUTH_MODE=local selects the pure-no-op LocalIdentityProvider regardless of IDENTITY_PROVIDER_TYPE
      // (ADR-0086 §5) — there is no external IdP to mirror to in local mode.
      useFactory: (logger: PinoLogger) =>
        createIdentityProvider(
          process.env.IDENTITY_PROVIDER_TYPE,
          logger,
          process.env.AUTH_MODE,
        ),
      inject: [PinoLogger],
    },
  ],
  exports: [
    JwtAuthGuard,
    RolesGuard,
    PermissionResolverService,
    IDENTITY_PROVIDER,
    LocalCredentialService,
    LocalProvisioningService,
  ],
})
export class AuthModule {}
