import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  AiConversationCreatedSchema,
  AiConversationDetailSchema,
  AiConversationSummarySchema,
  AiConversationSettingsSchema,
  AiRunAcceptedSchema,
  CreateAiConversationSchema,
  SendAiMessageSchema,
  UpdateAiConversationSchema,
  pageSchema,
  type AiConversationDetail,
  type AiConversationSettings,
  type AiConversationSummary,
  type AiRunAccepted,
  type Page,
} from '@lazyit/shared';
import { CurrentPrincipal } from '../../auth/current-principal.decorator';
import type { Principal } from '../../auth/principal';
import { RequirePermission } from '../../auth/require-permission.decorator';
import { parsePageQuery } from '../../common/parse-page-query';
import { aiHumanIdentityOf } from './ai-request-identity';
import { AiConversationsService } from './ai-conversations.service';
import { aiEntityId, localeOf } from './ai-http-params';

class SendAiMessageDto extends createZodDto(SendAiMessageSchema) {}
class AiConversationCreatedDto extends createZodDto(
  AiConversationCreatedSchema,
) {}
class AiConversationDetailDto extends createZodDto(
  AiConversationDetailSchema,
) {}
class AiConversationPageDto extends createZodDto(
  pageSchema(AiConversationSummarySchema),
) {}
class AiRunAcceptedDto extends createZodDto(AiRunAcceptedSchema) {}
/** The body is optional: an absent body (every client before #1373) is the instance defaults. */
class CreateAiConversationDto extends createZodDto(
  CreateAiConversationSchema.default({}),
) {}
class UpdateAiConversationDto extends createZodDto(
  UpdateAiConversationSchema,
) {}
class AiConversationSettingsDto extends createZodDto(
  AiConversationSettingsSchema,
) {}

/**
 * The in-app chat's conversations (ADR-0097; synthesis §4.7; frontend.md K3–K4). `ai:use` on every route,
 * the human channel only (a Service Account is refused 403 and uses `POST /ai/runs`), and OWNER ONLY:
 * another user's conversation — whoever asks, an admin included — answers 404 (ADR-0097 default 3).
 *
 * `DELETE /ai/conversations/:id` goes through the retention unit's purge service (W3-6), the one place
 * that hard-deletes a transcript.
 *
 * Refusals are `{ code, message }` bodies: 409 `AI_DISABLED` (create or send while the assistant is off),
 * 409 `RUN_IN_PROGRESS`, 409 `CONVERSATION_READ_ONLY`, 429 `RATE_LIMITED` / `BUDGET_EXCEEDED`, 403
 * `FORBIDDEN`. Reads and deletes keep working while AI is off.
 */
@ApiTags('ai')
@Controller('ai/conversations')
@RequirePermission('ai:use')
export class AiConversationsController {
  constructor(private readonly service: AiConversationsService) {}

  @Post()
  @ApiOperation({
    summary: 'Start a conversation with the assistant (ai:use)',
    description:
      'Creates and freezes a conversation: the configured provider, the model (the optional body’s `model` — ' +
      'any model of the configured provider — or the instance default), the prompt version and the toolset ' +
      'the caller holds now. Optional body `{ model?, effort?, providerOptions?, autoApprove? }` (#1373, #1376). ' +
      'The interface locale is taken from Accept-Language. 400 EFFORT_UNSUPPORTED / ' +
      'PROVIDER_OPTIONS_UNSUPPORTED; 409 AI_DISABLED while the assistant is off.',
  })
  @ApiCreatedResponse({ type: AiConversationCreatedDto })
  @ApiBadRequestResponse({
    description:
      'EFFORT_UNSUPPORTED, PROVIDER_OPTIONS_UNSUPPORTED, or an invalid body',
  })
  @ApiConflictResponse({ description: 'AI_DISABLED' })
  create(
    @Body() dto: CreateAiConversationDto,
    @CurrentPrincipal() principal?: Principal,
    @Headers('accept-language') acceptLanguage?: string,
  ): Promise<{ id: string }> {
    return this.service.create(
      aiHumanIdentityOf(principal),
      localeOf(acceptLanguage),
      dto,
    );
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Change a conversation’s model or auto-approve mode (ai:use, owner only)',
    description:
      '`{ model?, effort?, providerOptions?, autoApprove? }` → the conversation’s settings. The model, effort and ' +
      'options change only until the first run starts (409 CONVERSATION_SETTINGS_LOCKED afterwards — start a ' +
      'new conversation). Auto-approve toggles at any time and is audited: while on, ordinary writes whose preview ' +
      'needs no password step-up are applied without a card; elevated and step-up actions still ask. 404 for ' +
      'anyone but the owner.',
  })
  @ApiOkResponse({ type: AiConversationSettingsDto })
  @ApiBadRequestResponse({
    description:
      'EFFORT_UNSUPPORTED, PROVIDER_OPTIONS_UNSUPPORTED, or an invalid body',
  })
  @ApiNotFoundResponse({
    description: 'Not the caller’s conversation, or no such conversation.',
  })
  @ApiConflictResponse({
    description:
      'CONVERSATION_SETTINGS_LOCKED, CONVERSATION_READ_ONLY or AI_DISABLED',
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAiConversationDto,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<AiConversationSettings> {
    return this.service.update(
      aiHumanIdentityOf(principal),
      aiEntityId(id),
      dto,
    );
  }

  @Get()
  @ApiOperation({
    summary: "The caller's conversations, most recent first (ai:use)",
    description:
      'A Page<{ id, title, updatedAt, status, readOnly }> of the caller’s own chat conversations only.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiOkResponse({ type: AiConversationPageDto })
  list(
    @CurrentPrincipal() principal?: Principal,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
  ): Promise<Page<AiConversationSummary>> {
    const identity = aiHumanIdentityOf(principal);
    return this.service.list(identity, parsePageQuery({ limit, offset, page }));
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'One of the caller’s conversations, with its messages (ai:use, owner only)',
    description:
      'The messages are projected to a provider-neutral shape: text, tool activity, approval cards with ' +
      'their current state, and run notices. The stored provider messages and the runtime records never ' +
      'leave the API. Anyone but the owner gets 404.',
  })
  @ApiOkResponse({ type: AiConversationDetailDto })
  @ApiNotFoundResponse({
    description: 'Not the caller’s conversation, or no such conversation.',
  })
  detail(
    @Param('id') id: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<AiConversationDetail> {
    return this.service.detail(aiHumanIdentityOf(principal), aiEntityId(id));
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete one of the caller’s conversations (ai:use, owner only)',
    description:
      'Hard-deletes the transcript (ADR-0097: conversations are not the system of record); the permanent ' +
      'AI action ledger and the run rows are kept. 404 for anyone but the owner; 409 RUN_IN_PROGRESS ' +
      'while a run is active (cancel it first).',
  })
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiNotFoundResponse({
    description: 'Not the caller’s conversation, or no such conversation.',
  })
  @ApiConflictResponse({ description: 'RUN_IN_PROGRESS' })
  async remove(
    @Param('id') id: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<void> {
    await this.service.remove(aiHumanIdentityOf(principal), aiEntityId(id));
  }

  @Post(':id/messages')
  @HttpCode(202)
  @ApiOperation({
    summary:
      'Send a message; the assistant answers in a run (ai:use, owner only)',
    description:
      '`{ text, context?: { route, entity? } }` → 202 `{ runId, status }`; follow GET /ai/runs/:id/events. ' +
      'Only the route of `context` reaches the model. 409 RUN_IN_PROGRESS, CONVERSATION_READ_ONLY or ' +
      'AI_DISABLED; 429 RATE_LIMITED or BUDGET_EXCEEDED.',
  })
  @ApiAcceptedResponse({ type: AiRunAcceptedDto })
  @ApiConflictResponse({
    description: 'RUN_IN_PROGRESS, CONVERSATION_READ_ONLY or AI_DISABLED',
  })
  @ApiTooManyRequestsResponse({
    description: 'RATE_LIMITED or BUDGET_EXCEEDED',
  })
  send(
    @Param('id') id: string,
    @Body() dto: SendAiMessageDto,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<AiRunAccepted> {
    return this.service.send(aiHumanIdentityOf(principal), aiEntityId(id), dto);
  }
}
