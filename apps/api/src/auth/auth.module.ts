import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * Global auth module. Registers JwtAuthGuard as the application-wide guard via APP_GUARD.
 * PrismaService is available globally (PrismaModule is @Global), so JwtAuthGuard can inject it
 * without a separate PrismaModule import here.
 *
 * See ADR-0038 for the guard strategy and JIT provisioning decision.
 */
@Global()
@Module({
  providers: [
    JwtAuthGuard,
    // Apply the guard to every route in the application.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [JwtAuthGuard],
})
export class AuthModule {}
