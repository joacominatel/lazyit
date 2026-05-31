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
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { AccessGrantsService } from './access-grants.service';
import { parseActiveOnly, parseIncludeExpired } from './query-params';
import { parseUuidQuery } from '../common/parse-uuid-query';
import {
  AccessGrantDto,
  CreateAccessGrantDto,
  RevokeAccessGrantDto,
  UpdateAccessGrantExpiryDto,
  UpdateAccessGrantNotesDto,
} from './access-grant.dto';
import { CurrentUser } from '../auth/current-user.decorator';
import type { User } from '../../generated/prisma/client';

@ApiBearerAuth()
@ApiTags('access-grants')
@Controller('access-grants')
export class AccessGrantsController {
  constructor(private readonly grants: AccessGrantsService) {}

  @Get()
  @ApiOperation({
    summary:
      'List grants; filter by userId / applicationId. Active-only by default.',
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
  @ApiOkResponse({ type: [AccessGrantDto] })
  findAll(
    @Query('userId') userId?: string,
    @Query('applicationId') applicationId?: string,
    @Query('activeOnly') activeOnly?: string,
    @Query('includeExpired') includeExpired?: string,
  ) {
    return this.grants.findAll({
      userId: parseUuidQuery(userId, 'userId'),
      applicationId,
      activeOnly: parseActiveOnly(activeOnly),
      includeExpired: parseIncludeExpired(includeExpired),
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a grant by id' })
  @ApiOkResponse({ type: AccessGrantDto })
  findOne(@Param('id') id: string) {
    return this.grants.findOne(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Open a grant (give a user access to an application)',
  })
  @ApiCreatedResponse({ type: AccessGrantDto })
  create(
    @Body() dto: CreateAccessGrantDto,
    @CurrentUser() user?: User,
  ) {
    return this.grants.create(dto, user);
  }

  @Patch(':id/revoke')
  @ApiOperation({
    summary: 'Revoke an active grant (sets revokedAt; 409 if already revoked)',
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
  @ApiOperation({ summary: 'Update only the notes of a grant (null clears)' })
  @ApiOkResponse({ type: AccessGrantDto })
  updateNotes(@Param('id') id: string, @Body() dto: UpdateAccessGrantNotesDto) {
    return this.grants.updateNotes(id, dto);
  }

  @Patch(':id/expiry')
  @ApiOperation({
    summary: 'Change the expiry of a grant (null makes it permanent)',
  })
  @ApiOkResponse({ type: AccessGrantDto })
  updateExpiry(
    @Param('id') id: string,
    @Body() dto: UpdateAccessGrantExpiryDto,
  ) {
    return this.grants.updateExpiry(id, dto);
  }
}
