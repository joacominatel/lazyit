import {
  Body,
  Controller,
  HttpCode,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  ChangePasswordRequestSchema,
  ChangePasswordResponseSchema,
  ForgotPasswordRequestSchema,
  ForgotPasswordResponseSchema,
  ResetPasswordRequestSchema,
  ResetPasswordResponseSchema,
  type ChangePasswordResponse,
  type ForgotPasswordResponse,
  type ResetPasswordResponse,
} from '@lazyit/shared';
import type { User } from '../../../generated/prisma/client';
import { Public } from '../public.decorator';
import { CurrentUser } from '../current-user.decorator';
import { AllowPasswordChangeRequired } from '../allow-password-change-required.decorator';
import { ServicePrincipalForbiddenGuard } from '../service-principal-forbidden.guard';
import { PasswordLifecycleService } from './password-lifecycle.service';
import { PasswordResetRateLimitGuard } from './password-reset-rate-limit.guard';

// DTOs from the shared zod schemas: validation (global ZodValidationPipe) + TS types + OpenAPI schema.
class ChangePasswordRequestDto extends createZodDto(
  ChangePasswordRequestSchema,
) {}
class ChangePasswordResponseDto extends createZodDto(
  ChangePasswordResponseSchema,
) {}
class ForgotPasswordRequestDto extends createZodDto(
  ForgotPasswordRequestSchema,
) {}
class ForgotPasswordResponseDto extends createZodDto(
  ForgotPasswordResponseSchema,
) {}
class ResetPasswordRequestDto extends createZodDto(
  ResetPasswordRequestSchema,
) {}
class ResetPasswordResponseDto extends createZodDto(
  ResetPasswordResponseSchema,
) {}

/** The uniform forgot-password body — identical whether or not the account exists (no enumeration). */
const FORGOT_UNIFORM_RESPONSE: ForgotPasswordResponse = { ok: true };

/**
 * PasswordLifecycleController — the self-service password surface for AUTH_MODE=local (ADR-0086 §F4, F4a):
 *   - `POST /auth/change-password` — authenticated human; verifies the current password, sets the new one,
 *     revokes other sessions (epoch bump) and clears `mustChangePassword`. Exempt from the forced-change
 *     gate (it IS the escape hatch) and refuses a service principal.
 *   - `POST /auth/forgot-password` — `@Public()`, per-IP rate-limited; ALWAYS returns the uniform body
 *     (no user-enumeration). Emails a hashed single-use token link if SMTP is configured.
 *   - `POST /auth/reset-password` — `@Public()`, per-IP rate-limited; consumes a token and sets the new
 *     password (generic error on any invalid/expired/used token).
 *
 * All three are meaningful only in local mode; the service fails them closed in OIDC/shim mode.
 */
@ApiTags('auth')
@Controller('auth')
export class PasswordLifecycleController {
  constructor(private readonly passwords: PasswordLifecycleService) {}

  @Post('change-password')
  @HttpCode(200)
  // The escape hatch out of the forced-change wall — must stay reachable while mustChangePassword is set.
  @AllowPasswordChangeRequired()
  // Defense-in-depth: a service principal can never change a human password (it has no @CurrentUser
  // anyway; this makes the refusal explicit).
  @UseGuards(ServicePrincipalForbiddenGuard)
  @ApiOperation({
    summary: 'Change your own password (authenticated, local mode)',
    description:
      'Verifies the current password, sets the new one (strength-enforced), revokes all OTHER sessions ' +
      '(session-epoch bump) and clears any forced-change flag. Returns a fresh session token so the ' +
      'caller stays logged in. Only functional in AUTH_MODE=local.',
  })
  @ApiOkResponse({ type: ChangePasswordResponseDto })
  async changePassword(
    @Body() dto: ChangePasswordRequestDto,
    @CurrentUser() user?: User,
  ): Promise<ChangePasswordResponse> {
    // Non-@Public route: the guard guarantees a human user in local mode. Surface an anonymous/edge caller
    // as a clean 401 rather than a confusing 500.
    if (!user) {
      throw new UnauthorizedException('Not authenticated');
    }
    return this.passwords.changePassword(
      user,
      dto.currentPassword,
      dto.newPassword,
    );
  }

  @Public()
  @UseGuards(PasswordResetRateLimitGuard)
  @Post('forgot-password')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Request a password-reset link (public, per-IP rate-limited)',
    description:
      'Resolves an email-or-username to a live user and, if SMTP is configured, emails a single-use ' +
      'reset link. Returns an IDENTICAL response whether or not the account exists (no user-enumeration). ' +
      'Only functional in AUTH_MODE=local.',
  })
  @ApiOkResponse({ type: ForgotPasswordResponseDto })
  async forgotPassword(
    @Body() dto: ForgotPasswordRequestDto,
  ): Promise<ForgotPasswordResponse> {
    await this.passwords.forgotPassword(dto.identifier);
    // Uniform outcome — never reflects whether a user matched or an email was sent.
    return FORGOT_UNIFORM_RESPONSE;
  }

  @Public()
  @UseGuards(PasswordResetRateLimitGuard)
  @Post('reset-password')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reset a password with a token (public, per-IP rate-limited)',
    description:
      'Consumes a single-use reset token (looked up by its hash, TTL-checked), sets the new password ' +
      '(strength-enforced), revokes all sessions (epoch bump) and invalidates sibling tokens. Every ' +
      'invalid/expired/used token yields the same generic error. Only functional in AUTH_MODE=local.',
  })
  @ApiOkResponse({ type: ResetPasswordResponseDto })
  async resetPassword(
    @Body() dto: ResetPasswordRequestDto,
  ): Promise<ResetPasswordResponse> {
    await this.passwords.resetPassword(dto.token, dto.newPassword);
    return { ok: true };
  }
}
