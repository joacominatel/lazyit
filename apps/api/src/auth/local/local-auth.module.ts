import { Module } from '@nestjs/common';
import { SmtpModule } from '../../smtp/smtp.module';
import { UserHistoryModule } from '../../user-history/user-history.module';
import { LocalAuthController } from './local-auth.controller';
import { LoginService } from './login.service';
import { LoginRateLimitGuard } from './login-rate-limit.guard';
import { PasswordLifecycleController } from './password-lifecycle.controller';
import { PasswordLifecycleService } from './password-lifecycle.service';
import { PasswordResetRateLimitGuard } from './password-reset-rate-limit.guard';

/**
 * LocalAuthModule — the AUTH_MODE=local first-party auth surface (ADR-0086). Registers:
 *   - `POST /auth/login` (F1b) + its LoginService + per-IP rate-limit guard.
 *   - The password LIFECYCLE (F4a, ADR-0086 §F4): `POST /auth/change-password`, `/forgot-password`,
 *     `/reset-password` + {@link PasswordLifecycleService} + its per-IP rate-limit guard.
 *
 * The LocalCredentialService (hashing/session primitives) is provided + exported by the @Global
 * {@link ../auth.module AuthModule}, so the services inject it without importing it here. PrismaService is
 * likewise global. This module imports {@link SmtpModule} for the reset-email dispatch (SmtpService) and
 * {@link UserHistoryModule} for the append-only password-lifecycle audit. The forced-change GATE
 * (MustChangePasswordGuard) lives in AuthModule as an APP_GUARD and needs no wiring from here.
 */
@Module({
  imports: [SmtpModule, UserHistoryModule],
  controllers: [LocalAuthController, PasswordLifecycleController],
  providers: [
    LoginService,
    LoginRateLimitGuard,
    PasswordLifecycleService,
    PasswordResetRateLimitGuard,
  ],
})
export class LocalAuthModule {}
