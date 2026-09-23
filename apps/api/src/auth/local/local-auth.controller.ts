import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  LoginRequestSchema,
  LoginResponseSchema,
  type LoginResponse,
} from '@lazyit/shared';
import type { User } from '../../../generated/prisma/client';
import { Public } from '../public.decorator';
import { CurrentUser } from '../current-user.decorator';
import { AllowPasswordChangeRequired } from '../allow-password-change-required.decorator';
import { LoginService } from './login.service';
import { LoginRateLimitGuard } from './login-rate-limit.guard';

// DTOs from the shared zod schemas: validation (global ZodValidationPipe) + TS types + OpenAPI schema.
class LoginRequestDto extends createZodDto(LoginRequestSchema) {}
class LoginResponseDto extends createZodDto(LoginResponseSchema) {}

/**
 * LocalAuthController — the first-party login / logout surface for AUTH_MODE=local (ADR-0086 §3/§8).
 *
 * `POST /auth/login` is `@Public()` (no session exists yet by definition) and per-IP rate-limited by
 * {@link LoginRateLimitGuard}. It stays fail-closed in NON-local modes: an OIDC-linked user has a null
 * `passwordHash`, so the LoginService's dummy-hash verify simply returns the same generic 401 — the
 * endpoint authenticates no one unless real local credentials exist. Every failure is a uniform 401
 * ("Invalid credentials") — see LoginService for the no-enumeration / constant-time discipline.
 *
 * `POST /auth/logout` is authenticated (the global guard validates the Bearer) and revokes the session
 * server-side by bumping `sessionEpoch` — see {@link LoginService.logout}.
 */
@ApiTags('auth')
@Controller('auth')
export class LocalAuthController {
  constructor(private readonly loginService: LoginService) {}

  @Public()
  @UseGuards(LoginRateLimitGuard)
  @Post('login')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Local login (public, per-IP rate-limited)',
    description:
      'Exchanges an email-or-username + password for a first-party session token (HS256 JWT). ' +
      '`rememberMe: true` mints a token with no time-based expiry (`expiresAt: null`); otherwise it ' +
      'expires after 12h (`expiresAt` in epoch seconds). Only functional in AUTH_MODE=local. Returns a ' +
      'uniform 401 for every failure (no user-enumeration).',
  })
  @ApiOkResponse({ type: LoginResponseDto })
  async login(@Body() dto: LoginRequestDto): Promise<LoginResponse> {
    return this.loginService.login(
      dto.identifier,
      dto.password,
      dto.rememberMe,
    );
  }

  @Post('logout')
  @HttpCode(204)
  // Signing out must stay possible while the forced-change wall is up.
  @AllowPasswordChangeRequired()
  @ApiOperation({
    summary:
      'Sign out and revoke sessions server-side (authenticated, local mode)',
    description:
      "Bumps the caller's session epoch, so the presented token and every other session the user holds " +
      'stop authenticating. Idempotent: a repeat with the revoked token is a 401 and changes nothing. ' +
      'A no-op outside AUTH_MODE=local.',
  })
  @ApiNoContentResponse()
  async logout(@CurrentUser() user?: User): Promise<void> {
    // No human user (a service principal, or an anonymous shim request) holds no local session to revoke.
    if (!user) {
      return;
    }
    await this.loginService.logout(user);
  }
}
