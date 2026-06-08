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
import { WorkflowsService } from './workflows.service';
import {
  CreateApplicationWorkflowDto,
  CreateWorkflowVersionDto,
  UpdateApplicationWorkflowDto,
} from './workflow.dto';
import { RequirePermission } from '../../auth/require-permission.decorator';
import { CurrentPrincipal } from '../../auth/current-principal.decorator';
import type { Principal } from '../../auth/principal';
import { parseCuidQuery } from '../../common/parse-cuid-query';
import { parsePageQuery } from '../../common/parse-page-query';

/**
 * Workflow-definition CRUD (contract C1). Reads gated by `workflow:read`; mutations by `workflow:manage`
 * (ADMIN). Authoring a version validates the whole graph and returns field-addressable errors.
 */
@ApiTags('workflows')
@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Get()
  @RequirePermission('workflow:read')
  @ApiOperation({
    summary: 'List workflows (paginated). Filter by applicationId.',
  })
  @ApiQuery({ name: 'applicationId', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiOkResponse({ description: 'A page of workflow headers.' })
  findAll(
    @Query('applicationId') applicationId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
  ) {
    return this.workflows.findPage(
      parseCuidQuery(applicationId, 'applicationId'),
      parsePageQuery({ limit, offset, page }),
    );
  }

  @Get(':id')
  @RequirePermission('workflow:read')
  @ApiOperation({ summary: 'Get a workflow + its latest version full graph.' })
  findOne(@Param('id') id: string) {
    return this.workflows.findOne(id);
  }

  @Post()
  @RequirePermission('workflow:manage')
  @ApiOperation({
    summary:
      'Create a workflow binding (ADMIN). Disabled until configured + enabled.',
  })
  create(@Body() dto: CreateApplicationWorkflowDto) {
    return this.workflows.create(dto);
  }

  @Patch(':id')
  @RequirePermission('workflow:manage')
  @ApiOperation({ summary: 'Patch a workflow header (ADMIN).' })
  update(@Param('id') id: string, @Body() dto: UpdateApplicationWorkflowDto) {
    return this.workflows.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('workflow:manage')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Soft-delete a workflow (ADMIN). Frees the (app, trigger) slot.',
  })
  async remove(@Param('id') id: string): Promise<void> {
    await this.workflows.softDelete(id);
  }

  @Post(':id/versions')
  @RequirePermission('workflow:manage')
  @ApiOperation({
    summary:
      'Author a new immutable version (the step graph). Validates reachability + connection refs (ADMIN).',
  })
  authorVersion(
    @Param('id') id: string,
    @Body() dto: CreateWorkflowVersionDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.workflows.authorVersion(id, dto, principal);
  }
}
