import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Post,
  Put,
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
  MyPermissionsSchema,
  RolePermissionMatrixSchema,
  SetupAdminSchema,
  SetupResultSchema,
  UpdateRolePermissionsSchema,
  type MyPermissions,
  type RolePermissionMatrix,
  type SetupResult,
} from '@lazyit/shared';
import type { User } from '../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../auth/public.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ConfigService } from './config.service';
import { PermissionsConfigService } from './permissions-config.service';
import { SetupCsrfService } from './setup-csrf.service';
import { SetupRateLimitGuard } from './setup-rate-limit.guard';

// DTOs from the shared zod schemas: validation (global ZodValidationPipe) + TS types + OpenAPI schema.
class ConfigStatusDto extends createZodDto(ConfigStatusSchema) {}
class CsrfTokenDto extends createZodDto(CsrfTokenSchema) {}
class SetupAdminDto extends createZodDto(SetupAdminSchema) {}
class SetupResultDto extends createZodDto(SetupResultSchema) {}
class RolePermissionMatrixDto extends createZodDto(RolePermissionMatrixSchema) {}
class UpdateRolePermissionsDto extends createZodDto(
  UpdateRolePermissionsSchema,
) {}
class MyPermissionsDto extends createZodDto(MyPermissionsSchema) {}

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
    private readonly permissions: PermissionsConfigService,
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

  // ── Roles & Permissions v2 — P5: the configurable matrix (ADR-0046) ──────────────────────────────

  @RequirePermission('settings:manage')
  @Get('permissions')
  @ApiOperation({
    summary: 'Read the role→permission matrix (ADMIN — settings:manage)',
    description:
      'Returns the current RolePermissionMatrix (Record<Role, Permission[]>) read from the ' +
      'RolePermission rows. ADMIN is reported as the COMPLETE catalog (immutable/full — what the ' +
      'resolver enforces, never the DB rows). Gated by settings:manage (ADMIN-only in the seed).',
  })
  @ApiOkResponse({ type: RolePermissionMatrixDto })
  getPermissions(): Promise<RolePermissionMatrix> {
    return this.permissions.getMatrix();
  }

  @RequirePermission('settings:manage')
  @Put('permissions')
  @ApiOperation({
    summary: 'Replace the MEMBER + VIEWER permission sets (ADMIN — settings:manage)',
    description:
      'Replaces the MEMBER and VIEWER permission sets wholesale (a full PUT). The ADMIN row is ' +
      'IMMUTABLE — the strict body cannot name it (an ADMIN/extra key → 400); every permission must ' +
      'be in the @lazyit/shared catalog (unknown → 400). Applied transactionally; every added/removed ' +
      'permission is audited (PermissionAuditLog) with the actor, and the resolver cache is ' +
      'invalidated so the NEXT authorization decision reflects the change. Returns the new matrix.',
  })
  @ApiOkResponse({ type: RolePermissionMatrixDto })
  updatePermissions(
    @Body() dto: UpdateRolePermissionsDto,
    @CurrentUser() user?: User,
  ): Promise<RolePermissionMatrix> {
    return this.permissions.updateMatrix(dto, user?.id ?? null);
  }

  @RequirePermission()
  @Get('my-permissions')
  @ApiOperation({
    summary: "The caller's effective permissions (any authenticated user)",
    description:
      'Returns { role, permissions: Permission[] } for the CALLER, resolved via the ' +
      'PermissionResolverService — exactly what the guard enforces (ADMIN → the full catalog; ' +
      'MEMBER/VIEWER → their DB rows). Lets the frontend derive can(\'domain:action\') without ' +
      'polluting the User wire shape. No permission gate beyond authentication.',
  })
  @ApiOkResponse({ type: MyPermissionsDto })
  myPermissions(@CurrentUser() user?: User): Promise<MyPermissions> {
    // A @RequirePermission() with no args carries no gate (open to any authenticated user, per the
    // guard's state 3). In OIDC mode `user` is always set; in the anonymous shim edge it is absent —
    // then there is no role to resolve, so 403 (a missing actor can't have effective permissions).
    if (!user) {
      throw new ForbiddenException('Authentication required for this action');
    }
    return this.permissions.resolveFor(user.role);
  }

  /**
   * Express's VERIFIED `req.ip`, else the socket IP — for the first-run setup audit line (SEC-010).
   *
   * `req.ip` honours the app's `trust proxy` setting (main.ts): behind Caddy it is the real client
   * (Caddy's `trusted_proxies` drops a forged X-Forwarded-For from the public caller); in dev with
   * no proxy it is the socket address. Reading the raw leftmost X-Forwarded-For token — as before —
   * let a caller forge the audited first-run IP.
   */
  private clientIp(req: Request): string | undefined {
    return req.ip || req.socket?.remoteAddress || undefined;
  }
}
