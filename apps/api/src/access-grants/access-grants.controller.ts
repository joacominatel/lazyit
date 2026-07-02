import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { AccessGrantsService } from './access-grants.service';
import { parseBooleanQuery } from '../common/parse-boolean-query';
import { parseUuidQuery } from '../common/parse-uuid-query';
import { parseCuidQuery } from '../common/parse-cuid-query';
import { parsePageQuery } from '../common/parse-page-query';
import {
  AccessGrantDto,
  AccessGrantListPageDto,
  BatchResultDto,
  BatchRevokeGrantsDto,
  CreateAccessGrantDto,
  RevokeAccessGrantDto,
  UpdateAccessGrantExpiryDto,
  UpdateAccessGrantNotesDto,
} from './access-grant.dto';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import type { Principal } from '../auth/principal';
import type { User } from '../../generated/prisma/client';

@ApiTags('access-grants')
@Controller('access-grants')
export class AccessGrantsController {
  constructor(private readonly grants: AccessGrantsService) {}

  @Get()
  @RequirePermission('accessGrant:read')
  @ApiOperation({
    summary:
      'List grants (paginated; newest first); filter by userId / applicationId. Active-only by default.',
  })
  @ApiQuery({ name: 'userId', required: false })
  @ApiQuery({ name: 'applicationId', required: false })
  @ApiQuery({
    name: 'activeOnly',
    required: false,
    type: Boolean,
    description: 'Default true. Pass false to include revoked grants.',
  })
  @ApiQuery({
    name: 'includeExpired',
    required: false,
    type: Boolean,
    description:
      'Default true. Pass false to hide active grants already past their expiresAt.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Page size. Default 50, max 200 (ADR-0030).',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    description: 'Zero-based offset. Mutually redundant with page.',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: '1-based page number (alternative to offset).',
  })
  @ApiOkResponse({ type: AccessGrantListPageDto })
  findAll(
    @Query('userId') userId?: string,
    @Query('applicationId') applicationId?: string,
    @Query('activeOnly') activeOnly?: string,
    @Query('includeExpired') includeExpired?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
  ) {
    return this.grants.findPage(
      {
        userId: parseUuidQuery(userId, 'userId'),
        applicationId: parseCuidQuery(applicationId, 'applicationId'),
        activeOnly: parseBooleanQuery(activeOnly, true),
        includeExpired: parseBooleanQuery(includeExpired, true),
      },
      parsePageQuery({ limit, offset, page }),
    );
  }

  // SELF-SCOPE carve-out (issue #947) — STATIC route declared BEFORE the `:id` param route so
  // `/access-grants/mine` never resolves as an id. The caller's OWN grants (active + revoked history),
  // via the SAME `userId` where-clause the admin list uses. INTENTIONALLY NOT gated with
  // `accessGrant:read` (which a VIEWER does NOT hold): reading YOUR OWN grants is a self-read, so any
  // authenticated HUMAN may answer "what apps can I access?". The userId is taken ONLY from the
  // authenticated principal (never a query param) — no cross-user enumeration. A SERVICE account is
  // refused with 403 automatically (RolesGuard FAIL-CLOSED on an unannotated route, INV-SA-2). History
  // is included by default (`activeOnly=false`) so the profile shows current + past access in one read.
  @Get('mine')
  @ApiOperation({
    summary:
      "The caller's OWN access grants (active + revoked history). Any authenticated human; no accessGrant:read required (a self-read). Service accounts 403. Paginated (ADR-0030).",
  })
  @ApiQuery({
    name: 'activeOnly',
    required: false,
    type: Boolean,
    description:
      'Default false (includes revoked history). Pass true for active grants only.',
  })
  @ApiQuery({
    name: 'includeExpired',
    required: false,
    type: Boolean,
    description:
      'Default true. Pass false to hide active grants already past their expiresAt.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Page size. Default 50, max 200 (ADR-0030).',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    description: 'Zero-based offset. Mutually redundant with page.',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: '1-based page number (alternative to offset).',
  })
  @ApiOkResponse({ type: AccessGrantListPageDto })
  findMine(
    @Query('activeOnly') activeOnly?: string,
    @Query('includeExpired') includeExpired?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
    @CurrentUser() user?: User,
  ) {
    // The route is non-@Public, so a human is guaranteed in OIDC mode; in shim mode an anonymous
    // caller has no user — surface 401 rather than a confusing empty page (mirrors /users/me).
    if (!user) {
      throw new UnauthorizedException('Not authenticated');
    }
    return this.grants.findPage(
      {
        userId: user.id,
        activeOnly: parseBooleanQuery(activeOnly, false),
        includeExpired: parseBooleanQuery(includeExpired, true),
      },
      parsePageQuery({ limit, offset, page }),
    );
  }

  @Post('batch/revoke')
  @RequirePermission('accessGrant:grant')
  @ApiOperation({
    summary:
      'Bulk revoke active grants (per-grant revokedAt/revokedById; one transaction) — ADMIN only',
  })
  @ApiOkResponse({ type: BatchResultDto })
  batchRevoke(
    @Body() dto: BatchRevokeGrantsDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.grants.batchRevoke(dto.ids, dto.notes, principal);
  }

  @Get(':id')
  @RequirePermission('accessGrant:read')
  @ApiOperation({ summary: 'Get a grant by id' })
  @ApiOkResponse({ type: AccessGrantDto })
  findOne(@Param('id') id: string) {
    return this.grants.findOne(id);
  }

  @Post()
  @RequirePermission('accessGrant:grant')
  @ApiOperation({
    summary: 'Open a grant (give a user access to an application) — ADMIN only',
  })
  @ApiCreatedResponse({ type: AccessGrantDto })
  create(
    @Body() dto: CreateAccessGrantDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.grants.create(dto, principal);
  }

  @Patch(':id/revoke')
  @RequirePermission('accessGrant:grant')
  @ApiOperation({
    summary:
      'Revoke an active grant (sets revokedAt; 409 if already revoked) — ADMIN only',
  })
  @ApiOkResponse({ type: AccessGrantDto })
  @ApiConflictResponse({ description: 'The grant is already revoked' })
  revoke(
    @Param('id') id: string,
    @Body() dto: RevokeAccessGrantDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.grants.revoke(id, dto, principal);
  }

  @Patch(':id/notes')
  @RequirePermission('accessGrant:grant')
  @ApiOperation({
    summary: 'Update only the notes of a grant (null clears) — ADMIN only',
  })
  @ApiOkResponse({ type: AccessGrantDto })
  updateNotes(@Param('id') id: string, @Body() dto: UpdateAccessGrantNotesDto) {
    return this.grants.updateNotes(id, dto);
  }

  @Patch(':id/expiry')
  @RequirePermission('accessGrant:grant')
  @ApiOperation({
    summary:
      'Change the expiry of a grant (null makes it permanent) — ADMIN only',
  })
  @ApiOkResponse({ type: AccessGrantDto })
  updateExpiry(
    @Param('id') id: string,
    @Body() dto: UpdateAccessGrantExpiryDto,
  ) {
    return this.grants.updateExpiry(id, dto);
  }
}
