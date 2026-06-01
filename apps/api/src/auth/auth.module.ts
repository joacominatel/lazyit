import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';

/**
 * Global auth module. Registers the application-wide guards via APP_GUARD, IN ORDER:
 *   1. JwtAuthGuard — authentication (ADR-0038): sets request.user (OIDC JWT or X-User-Id shim).
 *   2. RolesGuard   — authorization (ADR-0040): enforces @Roles() AFTER request.user is populated.
 *
 * NestJS runs multiple APP_GUARD providers in registration order, so RolesGuard MUST be listed after
 * JwtAuthGuard or it would read an empty request.user. PrismaService is available globally
 * (PrismaModule is @Global), so JwtAuthGuard can inject it without importing PrismaModule here.
 *
 * See ADR-0038 (auth / JIT provisioning) and ADR-0040 (RBAC roles).
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
  ],
  exports: [JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
