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
import { WorkflowSecretsService } from './workflow-secrets.service';
import {
  CreateWorkflowSecretDto,
  RotateWorkflowSecretDto,
} from './workflow.dto';
import { RequirePermission } from '../../auth/require-permission.decorator';
import { parseCuidQuery } from '../../common/parse-cuid-query';
import { parsePageQuery } from '../../common/parse-page-query';

/**
 * Write-only WorkflowSecret CRUD (contract C1 / §4b, INV-6). Writes (create / rotate / delete) are gated
 * by `workflow:secrets` — a DISTINCT duty from `workflow:manage` (separation of duties: who holds the
 * Jira token ≠ who authors the automation). Reads return only the REDACTED descriptor (`configured`,
 * `label`) — never ciphertext; gated by `workflow:read`.
 */
@ApiTags('workflow-secrets')
@Controller('workflow-secrets')
export class WorkflowSecretsController {
  constructor(private readonly secrets: WorkflowSecretsService) {}

  @Get()
  @RequirePermission('workflow:read')
  @ApiOperation({
    summary:
      'List secrets as REDACTED descriptors (paginated). Filter by applicationId.',
  })
  @ApiQuery({ name: 'applicationId', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiOkResponse({ description: 'A page of redacted secret descriptors.' })
  findAll(
    @Query('applicationId') applicationId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
  ) {
    return this.secrets.findPage(
      parseCuidQuery(applicationId, 'applicationId'),
      parsePageQuery({ limit, offset, page }),
    );
  }

  @Get(':id')
  @RequirePermission('workflow:read')
  @ApiOperation({
    summary: 'Get a secret as a REDACTED descriptor (never the cleartext).',
  })
  findOne(@Param('id') id: string) {
    return this.secrets.findOne(id);
  }

  @Post()
  @RequirePermission('workflow:secrets')
  @ApiOperation({
    summary:
      'Create (encrypt) a secret — cleartext in once, never echoed (ADMIN).',
  })
  create(@Body() dto: CreateWorkflowSecretDto) {
    return this.secrets.create(dto);
  }

  @Patch(':id')
  @RequirePermission('workflow:secrets')
  @ApiOperation({
    summary:
      'Rotate a secret value in place — cleartext in once, never echoed (ADMIN).',
  })
  rotate(@Param('id') id: string, @Body() dto: RotateWorkflowSecretDto) {
    return this.secrets.rotate(id, dto.value);
  }

  @Delete(':id')
  @RequirePermission('workflow:secrets')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft-delete (revoke) a secret (ADMIN).' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.secrets.softDelete(id);
  }
}
