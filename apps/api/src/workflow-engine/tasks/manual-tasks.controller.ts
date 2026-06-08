import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import { createZodDto } from 'nestjs-zod';
import {
  CompleteManualTaskSchema,
  MANUAL_TASK_STATUSES,
  type ManualTaskStatus,
} from '@lazyit/shared';
import { ManualTasksService } from './manual-tasks.service';
import { RequirePermission } from '../../auth/require-permission.decorator';
import { CurrentPrincipal } from '../../auth/current-principal.decorator';
import type { Principal } from '../../auth/principal';
import { parseCuidQuery } from '../../common/parse-cuid-query';
import { parsePageQuery } from '../../common/parse-page-query';

/** The typed manual-task submission body (validated by the global ZodValidationPipe). */
export class CompleteManualTaskDto extends createZodDto(
  CompleteManualTaskSchema,
) {}

/**
 * The manual-task inbox endpoints (contract C5, frontend §6). Reads are gated by `workflow:read`;
 * resolutions (submit / skip / fail) by `workflow:task` PLUS the assignee IDOR guard inside the service.
 */
@ApiTags('workflow-tasks')
@Controller('workflow-tasks')
export class ManualTasksController {
  constructor(private readonly tasks: ManualTasksService) {}

  @Get()
  @RequirePermission('workflow:read')
  @ApiOperation({
    summary:
      'List manual tasks (default: pending). Filter by applicationId / status.',
  })
  @ApiQuery({ name: 'status', required: false, enum: MANUAL_TASK_STATUSES })
  @ApiQuery({ name: 'applicationId', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiOkResponse({ description: 'A page of manual tasks.' })
  findAll(
    @Query('status') status?: string,
    @Query('applicationId') applicationId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
  ) {
    return this.tasks.findPage(
      {
        status: parseTaskStatus(status),
        applicationId: parseCuidQuery(applicationId, 'applicationId'),
      },
      parsePageQuery({ limit, offset, page }),
    );
  }

  @Get(':id')
  @RequirePermission('workflow:read')
  @ApiOperation({
    summary:
      'Get a manual task + origin (MANUAL_STEP | ESCALATED_FAILURE) + input form + suggestions.',
  })
  @ApiOkResponse({ description: 'The manual task with its input form.' })
  findOne(@Param('id') id: string) {
    return this.tasks.findOne(id);
  }

  @Post(':id/submit')
  @RequirePermission('workflow:task')
  @ApiOperation({
    summary: 'Submit the typed input and resume the run at the next step.',
  })
  submit(
    @Param('id') id: string,
    @Body() dto: CompleteManualTaskDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.tasks.submit(id, dto, principal);
  }

  @Post(':id/skip')
  @RequirePermission('workflow:task')
  @ApiOperation({
    summary: 'Skip the data entry and continue the run at the success edge.',
  })
  skip(@Param('id') id: string, @CurrentPrincipal() principal?: Principal) {
    return this.tasks.skip(id, principal);
  }

  @Post(':id/fail')
  @RequirePermission('workflow:task')
  @ApiOperation({
    summary: 'Fail the task and resume the run down the failure edge.',
  })
  fail(@Param('id') id: string, @CurrentPrincipal() principal?: Principal) {
    return this.tasks.fail(id, principal);
  }
}

/** Validate the optional `status` filter against the closed manual-task-status enum (clean 400). */
function parseTaskStatus(
  value: string | undefined,
): ManualTaskStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!(MANUAL_TASK_STATUSES as readonly string[]).includes(value)) {
    throw new BadRequestException(
      `Invalid status: expected one of ${MANUAL_TASK_STATUSES.join(', ')}`,
    );
  }
  return value as ManualTaskStatus;
}
