import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { AccessGrantsService } from './access-grants.service';
import { parseActiveOnly, parseIncludeExpired } from './query-params';
import {
  AccessGrantDto,
  CreateAccessGrantDto,
  RevokeAccessGrantDto,
  UpdateAccessGrantExpiryDto,
  UpdateAccessGrantNotesDto,
} from './access-grant.dto';

// X-User-Id is the auth shim (ADR-0022). On grant writes it's OPTIONAL and becomes the actor
// (grantedById / revokedById); absent → null actor (system/unknown), allowed by design (ADR-0023).
const ACTOR_USER_HEADER = {
  name: 'X-User-Id',
  required: false,
  description:
    'Caller user id (auth shim). Optional; recorded as the grantor/revoker (null if absent).',
} as const;

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
      userId,
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
  @ApiHeader(ACTOR_USER_HEADER)
  @ApiCreatedResponse({ type: AccessGrantDto })
  create(
    @Body() dto: CreateAccessGrantDto,
    @Headers('x-user-id') actorId?: string,
  ) {
    return this.grants.create(dto, actorId);
  }

  @Patch(':id/revoke')
  @ApiOperation({
    summary: 'Revoke an active grant (sets revokedAt; 409 if already revoked)',
  })
  @ApiHeader(ACTOR_USER_HEADER)
  @ApiOkResponse({ type: AccessGrantDto })
  @ApiConflictResponse({ description: 'The grant is already revoked' })
  revoke(
    @Param('id') id: string,
    @Body() dto: RevokeAccessGrantDto,
    @Headers('x-user-id') actorId?: string,
  ) {
    return this.grants.revoke(id, dto, actorId);
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
