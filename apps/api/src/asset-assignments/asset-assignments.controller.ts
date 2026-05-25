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
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { AssetAssignmentsService } from './asset-assignments.service';
import { parseActiveOnly } from './active-only';
import {
  AssetAssignmentDto,
  CreateAssetAssignmentDto,
  ReleaseAssetAssignmentDto,
  UpdateAssetAssignmentNotesDto,
} from './asset-assignment.dto';

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
      userId,
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
  create(@Body() dto: CreateAssetAssignmentDto) {
    return this.assignments.create(dto);
  }

  @Patch(':id/release')
  @ApiOperation({
    summary: 'Release an active assignment (sets releasedAt; 409 if already released)',
  })
  @ApiOkResponse({ type: AssetAssignmentDto })
  release(@Param('id') id: string, @Body() dto: ReleaseAssetAssignmentDto) {
    return this.assignments.release(id, dto);
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
