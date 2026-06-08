import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { WorkflowDryRunService } from './workflow-dry-run.service';
import { WorkflowDryRunDto } from './workflow-dry-run.dto';
import { RequirePermission } from '../../auth/require-permission.decorator';
import { requestIdOf } from '../request-id';

/**
 * C4 — DRY-RUN endpoint (frontend §8 / §10). `POST /workflow-runs/dry-run`: a PURE payload-resolution
 * preview — it walks the pinned version's DAG, resolves each step's data mapping against a real sample
 * grant, and returns the would-be requests + the traversal in the SAME step-shaped data the run
 * timeline renders. It makes NO real external call and writes NO ledger rows; secret-backed values are
 * `‹secret:label›` placeholders (INV-6). Gated `workflow:manage` (ADMIN — same as the builder).
 *
 * Shares the `workflow-runs` path prefix with the read-only run-observability controller (C2); a POST
 * to the static `dry-run` segment never collides with its `GET :id`.
 */
@ApiTags('workflow-runs')
@Controller('workflow-runs')
export class WorkflowDryRunController {
  constructor(private readonly dryRun: WorkflowDryRunService) {}

  @Post('dry-run')
  @HttpCode(200)
  @RequirePermission('workflow:manage')
  @ApiOperation({
    summary:
      'C4 — Dry-run a workflow against a sample grant (ADMIN). Resolves payloads + the DAG traversal with NO side effects (no external call, no ledger rows). Pass simulate: { stepKey, outcome: FAILURE } to preview a failure edge.',
  })
  @ApiOkResponse({
    description:
      'The resolved would-be requests + the step-shaped traversal (same shape the run timeline renders), redacted (secrets shown as placeholders).',
  })
  run(@Body() dto: WorkflowDryRunDto, @Req() req: unknown) {
    return this.dryRun.dryRun(
      dto,
      requestIdOf(req as { id?: unknown; headers?: Record<string, unknown> }),
    );
  }
}
