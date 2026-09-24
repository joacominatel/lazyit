import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  AiConnectionDraftSchema,
  AiConnectionTestResultSchema,
  AiModelListSchema,
  AiSettingsSchema,
  UpdateAiSettingsSchema,
  type AiConnectionTestResult,
  type AiModelList,
  type AiSettings,
} from '@lazyit/shared';
import type { User } from '../../../generated/prisma/client';
import { EnvelopeKeyMissingError } from '../../common/crypto/envelope-cipher';
import { CurrentUser } from '../../auth/current-user.decorator';
import { RequirePermission } from '../../auth/require-permission.decorator';
import { ServicePrincipalForbiddenGuard } from '../../auth/service-principal-forbidden.guard';
import { AiSettingsService } from './ai-settings.service';

// DTOs from the shared zod schemas: validation (global ZodValidationPipe) + TS types + OpenAPI schema.
class AiSettingsDto extends createZodDto(AiSettingsSchema) {}
class UpdateAiSettingsDto extends createZodDto(UpdateAiSettingsSchema) {}
class AiConnectionDraftDto extends createZodDto(AiConnectionDraftSchema) {}
class AiConnectionTestResultDto extends createZodDto(
  AiConnectionTestResultSchema,
) {}
class AiModelListDto extends createZodDto(AiModelListSchema) {}

/**
 * The Settings → AI configuration surface (ADR-0097 decision 7; provider-and-runtime.md §9.1; synthesis
 * §4.7). `settings:manage` on every route plus {@link ServicePrincipalForbiddenGuard} at class level: a
 * service account can never configure the AI, whatever it holds (ADR-0048, INV-SA-3; security.md §6.5).
 * The provider key is WRITE-ONLY — no response ever carries it, only `apiKeySet`.
 */
@ApiTags('config')
@Controller('config/ai')
@RequirePermission('settings:manage')
@UseGuards(ServicePrincipalForbiddenGuard)
export class AiSettingsController {
  constructor(private readonly service: AiSettingsService) {}

  @Get()
  @ApiOperation({
    summary: 'Read the AI assistant configuration (ADMIN — settings:manage)',
    description:
      'The ai_settings singleton, or its DISABLED default when none has been saved. Redacted: `apiKeySet` ' +
      'says whether a provider key is stored, never the key; `keyConfigured` says whether AI_SECRET_KEY ' +
      'is usable. The MCP allowlist is the admin overlay on the curated defaults.',
  })
  @ApiOkResponse({ type: AiSettingsDto })
  get(): Promise<AiSettings> {
    return this.service.getSettings();
  }

  @Put()
  @ApiOperation({
    summary: 'Save the AI assistant configuration (ADMIN — settings:manage)',
    description:
      'A wholesale write. The key is write-only: omit it to keep, send a value to set, `null` to clear; ' +
      'changing the provider or base URL clears it. `enabled: true` passes the enable gate: the egress ' +
      'disclosure acknowledged, a provider and model, AI_SECRET_KEY usable for a key-bearing provider (409), ' +
      'the key where required, and a passing inline ' +
      'connection test when the connection is new or changed (422 with the reason and the test result). ' +
      'The MCP switch passes no gate. Every change is audited, redacted. A refused write persists nothing.',
  })
  @ApiOkResponse({ type: AiSettingsDto })
  @ApiConflictResponse({
    description:
      'A key write, or an enable of a key-bearing provider, without a usable AI_SECRET_KEY; or an enable in shim mode.',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'The enable gate refused: `{ code, message, test? }` — DISCLOSURE_REQUIRED, PROVIDER_NOT_CONFIGURED, API_KEY_REQUIRED or CONNECTION_TEST_FAILED.',
  })
  async update(
    @Body() dto: UpdateAiSettingsDto,
    @CurrentUser() user?: User,
  ): Promise<AiSettings> {
    try {
      return await this.service.updateSettings(dto, user?.id ?? null);
    } catch (err) {
      if (err instanceof EnvelopeKeyMissingError) {
        throw new ConflictException(err.message);
      }
      throw err;
    }
  }

  @Post('test')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Test an AI provider connection (ADMIN — settings:manage)',
    description:
      'Tests a DRAFT: body fields override the saved ones and the key may be supplied inline; an empty ' +
      'body tests the saved configuration. The saved key is used only while the provider and base URL are ' +
      'unchanged. One model step with a dummy `ping` tool answers `{ ok, checks: { auth, model, ' +
      'toolCalling }, latencyMs, error }` — 200 either way; `error` never echoes the upstream body or a ' +
      'credential. Persists nothing.',
  })
  @ApiOkResponse({ type: AiConnectionTestResultDto })
  test(@Body() dto: AiConnectionDraftDto): Promise<AiConnectionTestResult> {
    return this.service.testConnection(dto);
  }

  @Post('models')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Suggest models for a provider (ADMIN — settings:manage)',
    description:
      'Suggestions for the model field of the draft (or saved) provider. Free text is always allowed.',
  })
  @ApiOkResponse({ type: AiModelListDto })
  models(@Body() dto: AiConnectionDraftDto): Promise<AiModelList> {
    return this.service.listModels(dto);
  }
}
