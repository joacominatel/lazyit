import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
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
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
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

  @Post('batch/revoke')
  @Roles('ADMIN')
  @ApiOperation({
    summary:
      'Bulk revoke active grants (per-grant revokedAt/revokedById; one transaction) — ADMIN only',
  })
  @ApiOkResponse({ type: BatchResultDto })
  batchRevoke(@Body() dto: BatchRevokeGrantsDto, @CurrentUser() user?: User) {
    return this.grants.batchRevoke(dto.ids, dto.notes, user);
  }

  @Get(':id')
  @RequirePermission('accessGrant:read')
  @ApiOperation({ summary: 'Get a grant by id' })
  @ApiOkResponse({ type: AccessGrantDto })
  findOne(@Param('id') id: string) {
    return this.grants.findOne(id);
  }

  @Post()
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Open a grant (give a user access to an application) — ADMIN only',
  })
  @ApiCreatedResponse({ type: AccessGrantDto })
  create(@Body() dto: CreateAccessGrantDto, @CurrentUser() user?: User) {
    return this.grants.create(dto, user);
  }

  @Patch(':id/revoke')
  @Roles('ADMIN')
  @ApiOperation({
    summary:
      'Revoke an active grant (sets revokedAt; 409 if already revoked) — ADMIN only',
  })
  @ApiOkResponse({ type: AccessGrantDto })
  @ApiConflictResponse({ description: 'The grant is already revoked' })
  revoke(
    @Param('id') id: string,
    @Body() dto: RevokeAccessGrantDto,
    @CurrentUser() user?: User,
  ) {
    return this.grants.revoke(id, dto, user);
  }

  @Patch(':id/notes')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Update only the notes of a grant (null clears) — ADMIN only',
  })
  @ApiOkResponse({ type: AccessGrantDto })
  updateNotes(@Param('id') id: string, @Body() dto: UpdateAccessGrantNotesDto) {
    return this.grants.updateNotes(id, dto);
  }

  @Patch(':id/expiry')
  @Roles('ADMIN')
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
