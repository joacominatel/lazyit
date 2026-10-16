import {
  Body,
  ConflictException,
  Controller,
  Get,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  DirectoryConnectionSchema,
  DirectorySyncResultSchema,
  UpdateDirectoryConnectionSchema,
  type DirectoryConnection,
  type DirectorySyncResult,
} from '@lazyit/shared';
import { AdminOnlyGuard } from '../auth/admin-only.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ServicePrincipalForbiddenGuard } from '../auth/service-principal-forbidden.guard';
import { DirectoryConnectionService } from './directory-connection.service';
import { DirectoryReconcileService } from './directory-reconcile.service';
import { DirectorySecretKeyMissingError } from './directory.crypto';

// DTOs from the shared zod schemas: validation (global ZodValidationPipe) + TS types + OpenAPI schema.
class DirectoryConnectionDto extends createZodDto(DirectoryConnectionSchema) {}
class UpdateDirectoryConnectionDto extends createZodDto(
  UpdateDirectoryConnectionSchema,
) {}
class DirectorySyncResultDto extends createZodDto(DirectorySyncResultSchema) {}

/**
 * DirectoryController — the Settings → Instance → Directory surface (issue #839, ADR-0091). Lives under
 * `/directory` for the singleton AD/LDAP directory-source config + the ad-hoc "Sync now" action.
 *
 * All handlers are gated by `settings:manage` (the instance-config admin permission) and forbidden to
 * service principals (a bot must never reconfigure the org-wide directory or trigger a bulk person upsert),
 * matching the SMTP/config posture. The two writes are ADMIN-only on top (SEC-088): the sync can offboard
 * an AD-sourced admin, so a delegated `settings:manage` must not steer it. The bind password is
 * WRITE-ONLY: `GET` returns only `bindPasswordSet`.
 */
@ApiTags('directory')
@Controller('directory')
export class DirectoryController {
  constructor(
    private readonly config: DirectoryConnectionService,
    private readonly reconcile: DirectoryReconcileService,
  ) {}

  @RequirePermission('settings:manage')
  @UseGuards(ServicePrincipalForbiddenGuard)
  @Get('connection')
  @ApiOperation({
    summary: 'Read the AD/LDAP directory connection (ADMIN — settings:manage)',
    description:
      'Returns the single DirectoryConnection config row, or its explicit DISABLED default when none has ' +
      'been configured — never a 404. The bind password is WRITE-ONLY: the response carries ' +
      '`bindPasswordSet`, NEVER the value itself. Off by default (ADR-0091).',
  })
  @ApiOkResponse({ type: DirectoryConnectionDto })
  get(): Promise<DirectoryConnection> {
    return this.config.getSettings();
  }

  @RequirePermission('settings:manage')
  @UseGuards(ServicePrincipalForbiddenGuard, AdminOnlyGuard)
  @Put('connection')
  @ApiOperation({
    summary:
      'Configure the AD/LDAP directory connection (ADMIN only, even when settings:manage is delegated — SEC-088)',
    description:
      'A non-ADMIN caller is refused with 403 `ADMIN_REQUIRED` (SEC-088). Upserts the single config row. `enabled` is the master switch for the read-only sync. The ' +
      '`bindPassword` is write-only: omit it (or send empty) to KEEP the stored password, or send a ' +
      'non-empty value to set/rotate it (encrypted at rest under DIRECTORY_SECRET_KEY). Returns 409 if a ' +
      'password is supplied but DIRECTORY_SECRET_KEY is not configured. Returns the redacted config.',
  })
  @ApiOkResponse({ type: DirectoryConnectionDto })
  async update(
    @Body() dto: UpdateDirectoryConnectionDto,
  ): Promise<DirectoryConnection> {
    try {
      return await this.config.updateSettings(dto);
    } catch (err) {
      if (err instanceof DirectorySecretKeyMissingError) {
        // A password write with no server key — a config precondition, surfaced as a clean 409.
        throw new ConflictException(err.message);
      }
      throw err;
    }
  }

  @RequirePermission('settings:manage')
  @UseGuards(ServicePrincipalForbiddenGuard, AdminOnlyGuard)
  @Post('sync')
  @ApiOperation({
    summary:
      'Run the directory sync now (ADMIN only, even when settings:manage is delegated — SEC-088)',
    description:
      'A non-ADMIN caller is refused with 403 `ADMIN_REQUIRED` (SEC-088). Triggers the SAME read-only reconcile the scheduled sweeper runs: bind, subtree-search, and upsert ' +
      'login-less directory persons keyed on AD objectGUID. Always 200 with a redacted result ' +
      '`{ ok, startedAt, finishedAt, counts, error }`: on a bind/search failure `ok:false` + a short, ' +
      'non-secret `error` (never the bind password, DNs, or PII). Re-entrancy guarded: a concurrent run ' +
      'returns immediately without a second bind.',
  })
  @ApiOkResponse({ type: DirectorySyncResultDto })
  sync(): Promise<DirectorySyncResult> {
    return this.reconcile.reconcile();
  }
}
