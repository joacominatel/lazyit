import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import type { Request } from 'express';
import {
  ConfigStatusSchema,
  CsrfTokenSchema,
  SetupAdminSchema,
  SetupResultSchema,
  type SetupResult,
} from '@lazyit/shared';
import { Public } from '../auth/public.decorator';
import { ConfigService } from './config.service';
import { SetupCsrfService } from './setup-csrf.service';
import { SetupRateLimitGuard } from './setup-rate-limit.guard';

// DTOs from the shared zod schemas: validation (global ZodValidationPipe) + TS types + OpenAPI schema.
class ConfigStatusDto extends createZodDto(ConfigStatusSchema) {}
class CsrfTokenDto extends createZodDto(CsrfTokenSchema) {}
class SetupAdminDto extends createZodDto(SetupAdminSchema) {}
class SetupResultDto extends createZodDto(SetupResultSchema) {}

/**
 * ConfigController — the first-run setup surface (ADR-0043 Phase 3 §5).
 *
 * `GET /config/status` and `GET /config/csrf` are `@Public()`: the `/setup` wizard polls them before
 * any login exists. `POST /config/setup` is ALSO `@Public()` — by definition no ADMIN (hence no
 * authenticated session) exists at first-run, so it cannot be permission-gated (e.g. `settings:manage`);
 * instead it is
 * protected by Fork #7's three guards: (1) the idempotent any-ADMIN gate (409 once configured, in the
 * service), (2) a required CSRF token (the {@link SetupCsrfService}), and (3) the
 * {@link SetupRateLimitGuard}. Every admin creation is audited (in the service). This is the §6.3
 * "public-but-logged + rate-limited" posture — reachable through the reverse proxy for remote
 * first-run, never localhost-only.
 */
@ApiTags('config')
@Controller('config')
export class ConfigController {
  constructor(
    private readonly config: ConfigService,
    private readonly csrf: SetupCsrfService,
  ) {}

  @Public()
  @Get('status')
  @ApiOperation({
    summary:
      'First-run status (public) — isConfigured / integrationMode / devMode + a CSRF token',
    description:
      'Drives the /setup wizard and the topbar dev-mode banner. isConfigured is true once at least ' +
      'one ADMIN exists (derived, never a stored flag). Returns a CSRF token to echo on POST ' +
      '/config/setup. No secrets.',
  })
  @ApiOkResponse({ type: ConfigStatusDto })
  status(): Promise<ConfigStatusDto> {
    return this.config.getStatus();
  }

  @Public()
  @Get('csrf')
  @ApiOperation({
    summary: 'Issue a CSRF token for POST /config/setup (public)',
  })
  @ApiOkResponse({ type: CsrfTokenDto })
  csrfToken(): CsrfTokenDto {
    return { csrfToken: this.config.issueCsrfToken() };
  }

  @Public()
  @UseGuards(SetupRateLimitGuard)
  @Post('setup')
  @ApiOperation({
    summary: 'Create the first ADMIN (public, idempotent, CSRF + rate-limited)',
    description:
      'First-run bootstrap. 409 once any ADMIN exists (one-time gate). Requires a valid X-CSRF-Token ' +
      'header (from GET /config/status or GET /config/csrf). Rate-limited per IP. The role is locked ' +
      'to ADMIN. On zitadel mode with a configured Management credential the ADMIN is mirrored into ' +
      'the IdP, but a mirror failure degrades to a local-only ADMIN (never hard-blocks first-run).',
  })
  @ApiCreatedResponse({ type: SetupResultDto })
  async setup(
    @Body() dto: SetupAdminDto,
    @Headers('x-csrf-token') csrfToken: string | undefined,
    @Req() req: Request,
  ): Promise<SetupResult> {
    // CSRF gate (Fork #7): reject a request without a valid, unexpired token BEFORE any DB work.
    if (!this.csrf.verify(csrfToken)) {
      throw new ForbiddenException('Invalid or missing CSRF token');
    }
    const ip = this.clientIp(req);
    const outcome = await this.config.setup(dto, ip);
    return {
      success: true,
      adminId: outcome.adminId,
      email: outcome.email,
      mirrored: outcome.mirrored,
      setupCompletedAt: outcome.setupCompletedAt.toISOString(),
    };
  }

  /** First X-Forwarded-For hop, else the socket IP — for the setup audit line. */
  private clientIp(req: Request): string | undefined {
    const forwarded = req.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const xff = first?.split(',')[0]?.trim();
    return xff || req.ip || req.socket?.remoteAddress || undefined;
  }
}
