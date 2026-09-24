import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import {
  AiApprovalDecisionSchema,
  AiInputSubmissionSchema,
  AiRunAcceptedSchema,
  AiRunSchema,
  CreateAiRunSchema,
  type AiRun,
  type AiRunAccepted,
} from '@lazyit/shared';
import { CurrentPrincipal } from '../../auth/current-principal.decorator';
import type { Principal } from '../../auth/principal';
import { RequirePermission } from '../../auth/require-permission.decorator';
import {
  aiEntityId,
  aiToolCallId,
  idempotencyKeyOf,
  localeOf,
} from '../conversations/ai-http-params';
import { aiIdentityOf } from '../conversations/ai-request-identity';
import { AiRunsService } from './ai-runs.service';
import { AiRunEventStream } from './run-event-stream';

class CreateAiRunDto extends createZodDto(CreateAiRunSchema) {}
class AiApprovalDecisionDto extends createZodDto(AiApprovalDecisionSchema) {}
class AiInputSubmissionDto extends createZodDto(AiInputSubmissionSchema) {}
class AiRunAcceptedDto extends createZodDto(AiRunAcceptedSchema) {}
class AiRunDto extends createZodDto(AiRunSchema) {}

/**
 * Runs (ADR-0097 decisions 4–6; synthesis §4.4, §4.6, §4.7; provider-and-runtime.md §9). `ai:use` on every
 * route — a human through the role matrix, a Service Account through its direct grants (fail-closed,
 * INV-SA-2) — and OWNER ONLY: a run, its events, its cancel and its decisions answer 404 to anyone else,
 * an admin included.
 *
 * The channel follows the principal: a human's run is `CHAT` (writes wait for an approval), a Service
 * Account's is `HEADLESS` (autonomous within its grants and its per-SA AI access setting; `off` or holding
 * `infra:report` → 403 `FORBIDDEN`; `read-only` never lists a write tool). Writes on a critical
 * application are refused on the headless channel by core, and need the password on the chat.
 *
 * Refusals are `{ code, message, retryAfterSec? }` bodies. The decision endpoint's 403 `STEP_UP_*` codes
 * are about the password confirmation, never the session: a client must not treat them as a logout.
 */
@ApiTags('ai')
@Controller('ai/runs')
@RequirePermission('ai:use')
export class AiRunsController {
  constructor(
    private readonly runs: AiRunsService,
    private readonly eventStream: AiRunEventStream,
  ) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({
    summary:
      'Start a run: a headless prompt (Service Account) or a chat turn (ai:use)',
    description:
      '`{ prompt, conversationId? }` → 202 `{ runId, status }`; follow GET /ai/runs/:id/events or poll ' +
      'GET /ai/runs/:id. An `Idempotency-Key` header returns the earlier run for a repeated key (422 ' +
      'IDEMPOTENCY_KEY_MISMATCH when reused with another prompt or conversation). 403 ' +
      'FORBIDDEN (no ai:use, AI access off for the Service Account, or an SA holding infra:report); 409 ' +
      'AI_DISABLED, RUN_IN_PROGRESS or CONVERSATION_READ_ONLY; 429 RATE_LIMITED or BUDGET_EXCEEDED.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiAcceptedResponse({ type: AiRunAcceptedDto })
  @ApiForbiddenResponse({ description: 'FORBIDDEN' })
  @ApiConflictResponse({
    description: 'AI_DISABLED, RUN_IN_PROGRESS or CONVERSATION_READ_ONLY',
  })
  @ApiTooManyRequestsResponse({
    description: 'RATE_LIMITED or BUDGET_EXCEEDED',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'IDEMPOTENCY_KEY_MISMATCH — the key was used for another prompt or conversation',
  })
  async create(
    @Body() dto: CreateAiRunDto,
    @Res({ passthrough: true }) res: Response,
    @CurrentPrincipal() principal?: Principal,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('accept-language') acceptLanguage?: string,
  ): Promise<AiRunAccepted> {
    const { identity, channel } = aiIdentityOf(principal);
    const key = idempotencyKeyOf(idempotencyKey);
    const locale = localeOf(acceptLanguage);
    const { accepted, replayed } = await this.runs.create({
      identity,
      channel,
      body: dto,
      ...(key ? { idempotencyKey: key } : {}),
      ...(locale ? { locale } : {}),
    });
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return accepted;
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'A run: status, final text, usage and its tool calls (ai:use, owner only)',
  })
  @ApiOkResponse({ type: AiRunDto })
  @ApiNotFoundResponse({ description: 'Not the caller’s run, or no such run.' })
  get(
    @Param('id') id: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<AiRun> {
    return this.runs.get(aiEntityId(id), aiIdentityOf(principal).identity);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Stop a run (ai:use, owner only)',
    description:
      'A queued or waiting run ends now; a running one at its next step boundary (its in-flight model ' +
      'call is aborted). Idempotent: a finished run is answered as it is. Partial output is kept.',
  })
  @ApiOkResponse({ type: AiRunAcceptedDto })
  @ApiNotFoundResponse({ description: 'Not the caller’s run, or no such run.' })
  cancel(
    @Param('id') id: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<AiRunAccepted> {
    return this.runs.cancel(aiEntityId(id), aiIdentityOf(principal).identity);
  }

  @Post(':id/tool-calls/:toolCallId/decision')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Approve or reject a proposed change (ai:use, the run’s own user, human session)',
    description:
      '`{ decision: approve|reject, reason?, password? }` — the request carries only the decision; the ' +
      'approved arguments are the stored ones. `toolCallId` is the id announced by ' +
      '`tool.approval_required`. `password` is the step-up for actions that grant access or privilege, ' +
      'change a role or identity, or deliver a credential, and for every AI write on a critical ' +
      'application. Answers `{ runId, status }`; re-subscribe to the events. 403 STEP_UP_REQUIRED / ' +
      'STEP_UP_FAILED / STEP_UP_UNAVAILABLE are about the password, not the session; 429 ' +
      'STEP_UP_RATE_LIMITED with retryAfterSec; 409 RUN_NOT_AWAITING_APPROVAL, AI_DISABLED, or a core ' +
      'refusal (already decided, EXPIRED, STALE, PREVIEW_CHANGED); 403 FORBIDDEN for a Service Account. ' +
      'PREVIEW_CHANGED and a STEP_UP_REQUIRED raised by a new warning carry `addedWarnings`: the card ' +
      'changed, the action stays pending, and the user reviews it and decides again.',
  })
  @ApiOkResponse({ type: AiRunAcceptedDto })
  @ApiForbiddenResponse({
    description:
      'STEP_UP_REQUIRED, STEP_UP_FAILED, STEP_UP_UNAVAILABLE or FORBIDDEN',
  })
  @ApiConflictResponse({
    description:
      'RUN_NOT_AWAITING_APPROVAL, AI_DISABLED, PREVIEW_CHANGED (with addedWarnings) or a core refusal',
  })
  @ApiTooManyRequestsResponse({ description: 'STEP_UP_RATE_LIMITED' })
  @ApiNotFoundResponse({ description: 'Not the caller’s run or action.' })
  decide(
    @Param('id') id: string,
    @Param('toolCallId') toolCallId: string,
    @Body() dto: AiApprovalDecisionDto,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<AiRunAccepted> {
    return this.runs.decide({
      runId: aiEntityId(id),
      toolCallId: aiToolCallId(toolCallId),
      identity: aiIdentityOf(principal).identity,
      body: dto,
    });
  }

  @Post(':id/tool-calls/:toolCallId/input')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Answer a form the assistant asked for (ai:use, the run’s own user, human session)',
    description:
      '`{ action: submit|skip|cancel, values?, groups? }` (#1388). `toolCallId` is the id announced by ' +
      '`input.required`. `submit` is validated against the STORED form: unknown keys, a missing ' +
      'required field, a wrong type, an option that was not offered or a row count out of bounds → 400 ' +
      'INVALID_INPUT with `issues` [{ path, message }]. `skip` continues without the data; `cancel` ' +
      'declines it (the assistant is told not to ask again). Answers `{ runId, status }`; re-subscribe to ' +
      'the events. 409 RUN_NOT_AWAITING_INPUT (already answered, or the run is not waiting), EXPIRED (the ' +
      'run ends EXPIRED) or AI_DISABLED; 403 FORBIDDEN for a Service Account.',
  })
  @ApiOkResponse({ type: AiRunAcceptedDto })
  @ApiBadRequestResponse({ description: 'INVALID_INPUT, with issues' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN' })
  @ApiConflictResponse({
    description: 'RUN_NOT_AWAITING_INPUT, EXPIRED or AI_DISABLED',
  })
  @ApiNotFoundResponse({ description: 'Not the caller’s run or form.' })
  submitInput(
    @Param('id') id: string,
    @Param('toolCallId') toolCallId: string,
    @Body() dto: AiInputSubmissionDto,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<AiRunAccepted> {
    return this.runs.submitInput({
      runId: aiEntityId(id),
      toolCallId: aiToolCallId(toolCallId),
      identity: aiIdentityOf(principal).identity,
      body: dto,
    });
  }

  @Get(':id/events')
  @ApiOperation({
    summary: 'The run’s event stream (ai:use, owner only) — text/event-stream',
    description:
      'Read with fetch and an Authorization header. Frames carry `id: <runId>:<seq>` (increasing, not ' +
      'consecutive), `event: <type>` and a JSON `data` from the versioned `AiRunEvent` union. Reconnect ' +
      'with `Last-Event-ID` to resume; a position the server no longer holds is answered with a ' +
      '`run.snapshot`. Heartbeat comments every 15 s. The stream closes after a terminal status or after ' +
      'AWAITING_APPROVAL or AWAITING_INPUT; re-subscribe after deciding or answering.',
  })
  @ApiHeader({ name: 'Last-Event-ID', required: false })
  @ApiProduces('text/event-stream')
  @ApiOkResponse({ description: 'The event stream.' })
  @ApiNotFoundResponse({ description: 'Not the caller’s run, or no such run.' })
  @ApiTooManyRequestsResponse({
    description: 'RATE_LIMITED (too many open streams)',
  })
  stream(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentPrincipal() principal?: Principal,
    @Headers('last-event-id') lastEventId?: string,
  ): Promise<void> {
    return this.eventStream.stream({
      runId: aiEntityId(id),
      identity: aiIdentityOf(principal).identity,
      lastEventId,
      req,
      res,
    });
  }
}
