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
import { AssetAssignmentsService } from './asset-assignments.service';
import { parseBooleanQuery } from '../common/parse-boolean-query';
import { parseUuidQuery } from '../common/parse-uuid-query';
import { parseCuidQuery } from '../common/parse-cuid-query';
import {
  AssetAssignmentDto,
  CreateAssetAssignmentDto,
  ReleaseAssetAssignmentDto,
  UpdateAssetAssignmentNotesDto,
} from './asset-assignment.dto';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import type { User } from '../../generated/prisma/client';

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
      assetId: parseCuidQuery(assetId, 'assetId'),
      userId: parseUuidQuery(userId, 'userId'),
      activeOnly: parseBooleanQuery(activeOnly, true),
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an assignment by id' })
  @ApiOkResponse({ type: AssetAssignmentDto })
  findOne(@Param('id') id: string) {
    return this.assignments.findOne(id);
  }

  @Post()
  @Roles('ADMIN', 'MEMBER')
  @ApiOperation({
    summary: 'Open an assignment (assign a user to an asset) (ADMIN or MEMBER)',
  })
  @ApiCreatedResponse({ type: AssetAssignmentDto })
  create(
    @Body() dto: CreateAssetAssignmentDto,
    @CurrentUser() user?: User,
  ) {
    return this.assignments.create(dto, user);
  }

  @Patch(':id/release')
  @Roles('ADMIN', 'MEMBER')
  @ApiOperation({
    summary:
      'Release an active assignment (sets releasedAt; 409 if already released) (ADMIN or MEMBER)',
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
  @Roles('ADMIN', 'MEMBER')
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
}
