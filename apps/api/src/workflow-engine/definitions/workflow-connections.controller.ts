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
  Req,
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
import { CurrentPrincipal } from '../../auth/current-principal.decorator';
import type { Principal } from '../../auth/principal';
import { parseCuidQuery } from '../../common/parse-cuid-query';
import { parsePageQuery } from '../../common/parse-page-query';
import { requestIdOf } from '../request-id';

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
      'Patch a connection (name / config / credential reference) (ADMIN). Attaching a secretId or re-pointing the host of a secret-bearing connection additionally requires workflow:secrets (CSEC-1 SoD).',
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateWorkflowConnectionDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.connections.update(id, dto, principal);
  }

  @Post(':id/test')
  @HttpCode(200)
  @RequirePermission('workflow:manage')
  @ApiOperation({
    summary:
      'C3 — Test a connection (ADMIN). A single bounded, READ-ONLY probe of connectivity + credential; never provisions / POSTs a mutation, never echoes the secret. Returns { ok, status?, message, requestId }.',
  })
  @ApiOkResponse({
    description:
      'The probe outcome: { ok, status?, message, requestId }. A MANUAL/webhook connection returns a "nothing to test" message.',
  })
  test(@Param('id') id: string, @Req() req: unknown) {
    return this.connections.test(
      id,
      requestIdOf(req as { id?: unknown; headers?: Record<string, unknown> }),
    );
  }

  @Delete(':id')
  @RequirePermission('workflow:manage')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft-delete a connection (ADMIN).' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.connections.softDelete(id);
  }
}
