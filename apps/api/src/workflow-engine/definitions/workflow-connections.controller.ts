import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { WorkflowConnectionsService } from './workflow-connections.service';
import {
  CreateWorkflowConnectionDto,
  UpdateWorkflowConnectionDto,
} from './workflow.dto';
import { RequirePermission } from '../../auth/require-permission.decorator';
import { parseCuidQuery } from '../../common/parse-cuid-query';
import { parsePageQuery } from '../../common/parse-page-query';

/**
 * WorkflowConnection CRUD (contract C1). Reads gated by `workflow:read`; mutations by `workflow:manage`
 * (ADMIN — configuring the engine). `config` is non-secret per-kind settings; credentials are a separate
 * `secretId` reference (the secrets endpoints), never inlined here (INV-6).
 */
@ApiTags('workflow-connections')
@Controller('workflow-connections')
export class WorkflowConnectionsController {
  constructor(private readonly connections: WorkflowConnectionsService) {}

  @Get()
  @RequirePermission('workflow:read')
  @ApiOperation({
    summary: 'List connections (paginated). Filter by applicationId.',
  })
  @ApiQuery({ name: 'applicationId', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiOkResponse({ description: 'A page of connections.' })
  findAll(
    @Query('applicationId') applicationId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
  ) {
    return this.connections.findPage(
      parseCuidQuery(applicationId, 'applicationId'),
      parsePageQuery({ limit, offset, page }),
    );
  }

  @Get(':id')
  @RequirePermission('workflow:read')
  @ApiOperation({ summary: 'Get a connection by id.' })
  findOne(@Param('id') id: string) {
    return this.connections.findOne(id);
  }

  @Post()
  @RequirePermission('workflow:manage')
  @ApiOperation({ summary: 'Create a connection (ADMIN).' })
  create(@Body() dto: CreateWorkflowConnectionDto) {
    return this.connections.create(dto);
  }

  @Patch(':id')
  @RequirePermission('workflow:manage')
  @ApiOperation({
    summary:
      'Patch a connection (name / config / credential reference) (ADMIN).',
  })
  update(@Param('id') id: string, @Body() dto: UpdateWorkflowConnectionDto) {
    return this.connections.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('workflow:manage')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft-delete a connection (ADMIN).' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.connections.softDelete(id);
  }
}
