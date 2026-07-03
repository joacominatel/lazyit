import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  LoginRequestSchema,
  LoginResponseSchema,
  type LoginResponse,
} from '@lazyit/shared';
import { Public } from '../public.decorator';
import { LoginService } from './login.service';
import { LoginRateLimitGuard } from './login-rate-limit.guard';

// DTOs from the shared zod schemas: validation (global ZodValidationPipe) + TS types + OpenAPI schema.
class LoginRequestDto extends createZodDto(LoginRequestSchema) {}
class LoginResponseDto extends createZodDto(LoginResponseSchema) {}

/**
 * LocalAuthController — the first-party login surface for AUTH_MODE=local (ADR-0086 §3).
 *
 * `POST /auth/login` is `@Public()` (no session exists yet by definition) and per-IP rate-limited by
 * {@link LoginRateLimitGuard}. It stays fail-closed in NON-local modes: an OIDC-linked user has a null
 * `passwordHash`, so the LoginService's dummy-hash verify simply returns the same generic 401 — the
 * endpoint authenticates no one unless real local credentials exist. Every failure is a uniform 401
 * ("Invalid credentials") — see LoginService for the no-enumeration / constant-time discipline.
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
      'Only functional in AUTH_MODE=local. Returns a uniform 401 for every failure (no user-enumeration).',
  })
  @ApiOkResponse({ type: LoginResponseDto })
  async login(@Body() dto: LoginRequestDto): Promise<LoginResponse> {
    return this.loginService.login(dto.identifier, dto.password);
  }
}
