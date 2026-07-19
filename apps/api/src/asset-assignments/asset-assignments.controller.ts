import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { AssetAssignmentsService } from './asset-assignments.service';
import { parseBooleanQuery } from '../common/parse-boolean-query';
import { parseUuidQuery } from '../common/parse-uuid-query';
import { parseCuidQuery } from '../common/parse-cuid-query';
import {
  AcknowledgeAssignmentDto,
  AssetAssignmentDto,
  CreateAssetAssignmentDto,
  ReleaseAssetAssignmentDto,
  UpdateAssetAssignmentNotesDto,
} from './asset-assignment.dto';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ServicePrincipalForbiddenGuard } from '../auth/service-principal-forbidden.guard';
import type { Principal } from '../auth/principal';

@ApiTags('asset-assignments')
@Controller('asset-assignments')
export class AssetAssignmentsController {
  constructor(private readonly assignments: AssetAssignmentsService) {}

  @Get()
  @RequirePermission('asset:read')
  @ApiOperation({
    summary:
      'List assignments; filter by assetId / userId. Active-only by default.',
  })
  @ApiQuery({ name: 'assetId', required: false })
  @ApiQuery({ name: 'userId', required: false })
  @ApiQuery({
    name: 'activeOnly',
    required: false,
    type: Boolean,
    description: 'Default true. Pass false to include released assignments.',
  })
  @ApiOkResponse({ type: [AssetAssignmentDto] })
  findAll(
    @Query('assetId') assetId?: string,
    @Query('userId') userId?: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    return this.assignments.findAll({
      assetId: parseCuidQuery(assetId, 'assetId'),
      userId: parseUuidQuery(userId, 'userId'),
      activeOnly: parseBooleanQuery(activeOnly, true),
    });
  }

  @Get(':id')
  @RequirePermission('asset:read')
  @ApiOperation({ summary: 'Get an assignment by id' })
  @ApiOkResponse({ type: AssetAssignmentDto })
  findOne(@Param('id') id: string) {
    return this.assignments.findOne(id);
  }

  @Post()
  @RequirePermission('asset:write')
  @ApiOperation({
    summary: 'Open an assignment (assign a user to an asset) (ADMIN or MEMBER)',
  })
  @ApiCreatedResponse({ type: AssetAssignmentDto })
  create(
    @Body() dto: CreateAssetAssignmentDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.assignments.create(dto, principal);
  }

  @Patch(':id/release')
  @RequirePermission('asset:write')
  @ApiOperation({
    summary:
      'Release an active assignment (sets releasedAt; 409 if already released) (ADMIN or MEMBER)',
  })
  @ApiOkResponse({ type: AssetAssignmentDto })
  @ApiConflictResponse({ description: 'The assignment is already released' })
  release(
    @Param('id') id: string,
    @Body() dto: ReleaseAssetAssignmentDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.assignments.release(id, dto, principal);
  }

  @Patch(':id/notes')
  @RequirePermission('asset:write')
  @ApiOperation({
    summary: 'Update only the notes of an assignment (ADMIN or MEMBER)',
  })
  @ApiOkResponse({ type: AssetAssignmentDto })
  updateNotes(
    @Param('id') id: string,
    @Body() dto: UpdateAssetAssignmentNotesDto,
  ) {
    return this.assignments.updateNotes(id, dto);
  }

  // Check-out acknowledgement (ADR-0089 Part B, #1029). SELF-SERVICE: NO @RequirePermission — the
  // authorization is "it's your OWN active assignment" (open-by-default for humans, INV-8), enforced by
  // the service's self-scoped conditional write. Human-only, so ServicePrincipalForbiddenGuard 403s a
  // service account (an asset is checked out to a person, not a bot). The acting user comes from the
  // authenticated principal, never the body.
  @Post(':id/acknowledge')
  @UseGuards(ServicePrincipalForbiddenGuard)
  @ApiOperation({
    summary:
      'Acknowledge receipt of an asset checked out to you (self-service; your OWN active assignment; human-only). 409 if already acknowledged / released / not yours.',
  })
  @ApiOkResponse({ type: AssetAssignmentDto })
  @ApiConflictResponse({
    description:
      'The assignment is already acknowledged, already released, or not the caller’s own',
  })
  acknowledge(
    @Param('id') id: string,
    @Body() dto: AcknowledgeAssignmentDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.assignments.acknowledge(id, dto, principal);
  }
}
