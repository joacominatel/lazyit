import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { WORKFLOW_RUN_STATUSES, type WorkflowRunStatus } from '@lazyit/shared';
import { WorkflowRunsService } from './workflow-runs.service';
import { RequirePermission } from '../../auth/require-permission.decorator';
import { parseCuidQuery } from '../../common/parse-cuid-query';
import { parsePageQuery } from '../../common/parse-page-query';

/**
 * Run observability endpoints (contract C2, frontend §7 / §10). Reads are gated by `workflow:read`
 * (admin-only — run history reveals who-gets-provisioned-where, treated like `logs:read`); the manual
 * RETRY action (issue #308) is gated by `workflow:run` (re-driving a failed run — separated from `read`
 * per ADR-0054 §10 / frontend §9, so ops can re-drive without seeing every definition). All bodies are
 * pre-redacted (INV-6).
 */
@ApiTags('workflow-runs')
@Controller('workflow-runs')
export class WorkflowRunsController {
  constructor(private readonly runs: WorkflowRunsService) {}

  @Get()
  @RequirePermission('workflow:read')
  @ApiOperation({
    summary:
      'List workflow runs (paginated; newest first). Filter by applicationId / workflowId / accessGrantId / status.',
  })
  @ApiQuery({ name: 'applicationId', required: false })
  @ApiQuery({ name: 'workflowId', required: false })
  @ApiQuery({ name: 'accessGrantId', required: false })
  @ApiQuery({ name: 'status', required: false, enum: WORKFLOW_RUN_STATUSES })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiOkResponse({ description: 'A page of run summaries.' })
  findAll(
    @Query('applicationId') applicationId?: string,
    @Query('workflowId') workflowId?: string,
    @Query('accessGrantId') accessGrantId?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
  ) {
    return this.runs.findPage(
      {
        applicationId: parseCuidQuery(applicationId, 'applicationId'),
        workflowId: parseCuidQuery(workflowId, 'workflowId'),
        accessGrantId: parseCuidQuery(accessGrantId, 'accessGrantId'),
        status: parseRunStatus(status),
      },
      parsePageQuery({ limit, offset, page }),
    );
  }

  @Get(':id')
  @RequirePermission('workflow:read')
  @ApiOperation({
    summary:
      'Get a run + its ordered step attempts (status / attempt / durationMs / transitionTaken / manual-task & compensation linkage).',
  })
  @ApiOkResponse({
    description: 'The run with its ordered, projected step attempts.',
  })
  findOne(@Param('id') id: string) {
    return this.runs.findOne(id);
  }

  @Post(':id/retry')
  @HttpCode(200)
  @RequirePermission('workflow:run')
  @ApiOperation({
    summary:
      'Retry a terminal FAILED run from the step that failed onward (issue #308). Resume-from-failed-step, NOT a full re-run — already-SUCCEEDED steps are not re-executed (no double-provision). 409 if the run is not FAILED; 422 if it has no resolvable failed step.',
  })
  @ApiOkResponse({
    description:
      'The retry was accepted — the run is re-enqueued from the failed step; returns the resumed step key + the new attempt number.',
  })
  retry(@Param('id') id: string) {
    return this.runs.retry(id);
  }
}

/** Validate the optional `status` filter against the closed run-status enum (clean 400 otherwise). */
function parseRunStatus(
  value: string | undefined,
): WorkflowRunStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!(WORKFLOW_RUN_STATUSES as readonly string[]).includes(value)) {
    throw new BadRequestException(
      `Invalid status: expected one of ${WORKFLOW_RUN_STATUSES.join(', ')}`,
    );
  }
  return value as WorkflowRunStatus;
}
