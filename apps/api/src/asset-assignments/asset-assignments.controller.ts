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
import { AssetAssignmentsService } from './asset-assignments.service';
import { parseActiveOnly } from './active-only';
import { parseUuidQuery } from '../common/parse-uuid-query';
import {
  AssetAssignmentDto,
  CreateAssetAssignmentDto,
  ReleaseAssetAssignmentDto,
  UpdateAssetAssignmentNotesDto,
} from './asset-assignment.dto';
import { CurrentUser } from '../auth/current-user.decorator';
import type { User } from '../../generated/prisma/client';

@ApiBearerAuth()
@ApiTags('asset-assignments')
@Controller('asset-assignments')
export class AssetAssignmentsController {
  constructor(private readonly assignments: AssetAssignmentsService) {}

  @Get()
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
      assetId,
      userId: parseUuidQuery(userId, 'userId'),
      activeOnly: parseActiveOnly(activeOnly),
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an assignment by id' })
  @ApiOkResponse({ type: AssetAssignmentDto })
  findOne(@Param('id') id: string) {
    return this.assignments.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Open an assignment (assign a user to an asset)' })
  @ApiCreatedResponse({ type: AssetAssignmentDto })
  create(
    @Body() dto: CreateAssetAssignmentDto,
    @CurrentUser() user?: User,
  ) {
    return this.assignments.create(dto, user);
  }

  @Patch(':id/release')
  @ApiOperation({
    summary:
      'Release an active assignment (sets releasedAt; 409 if already released)',
  })
  @ApiOkResponse({ type: AssetAssignmentDto })
  @ApiConflictResponse({ description: 'The assignment is already released' })
  release(
    @Param('id') id: string,
    @Body() dto: ReleaseAssetAssignmentDto,
    @CurrentUser() user?: User,
  ) {
    return this.assignments.release(id, dto, user);
  }

  @Patch(':id/notes')
  @ApiOperation({ summary: 'Update only the notes of an assignment' })
  @ApiOkResponse({ type: AssetAssignmentDto })
  updateNotes(
    @Param('id') id: string,
    @Body() dto: UpdateAssetAssignmentNotesDto,
  ) {
    return this.assignments.updateNotes(id, dto);
  }
}
