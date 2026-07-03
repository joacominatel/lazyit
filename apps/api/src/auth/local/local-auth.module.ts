import { Module } from '@nestjs/common';
import { LocalAuthController } from './local-auth.controller';
import { LoginService } from './login.service';
import { LoginRateLimitGuard } from './login-rate-limit.guard';

/**
 * LocalAuthModule — the AUTH_MODE=local login surface (ADR-0086 §3, F1b). Registers the public
 * `POST /auth/login` controller + its LoginService and per-IP rate-limit guard.
 *
 * The LocalCredentialService (hashing/session primitives) is provided + exported by the @Global
 * {@link AuthModule}, so LoginService injects it without importing it here. PrismaService is likewise
 * global. This module is imported into AppModule alongside the other feature modules; the guard itself
 * (JwtAuthGuard.handleLocal) lives in AuthModule and needs no wiring from here.
 */
@Module({
  controllers: [LocalAuthController],
  providers: [LoginService, LoginRateLimitGuard],
})
export class LocalAuthModule {}
