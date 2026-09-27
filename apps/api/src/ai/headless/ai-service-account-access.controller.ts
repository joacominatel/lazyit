import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  AiServiceAccountSettingsSchema,
  type AiServiceAccountSettings,
} from '@lazyit/shared';
import type { User } from '../../../generated/prisma/client';
import { CurrentUser } from '../../auth/current-user.decorator';
import { RequirePermission } from '../../auth/require-permission.decorator';
import { ServicePrincipalForbiddenGuard } from '../../auth/service-principal-forbidden.guard';
import { aiEntityId } from '../conversations/ai-http-params';
import { AiServiceAccountAccessService } from './ai-service-account-access.service';

class AiServiceAccountSettingsDto extends createZodDto(
  AiServiceAccountSettingsSchema,
) {}

/**
 * `GET` / `PUT /config/ai/service-accounts/:id` — a Service Account's AI access (synthesis §4.7; frontend.md
 * K2). The AI configuration gate: `settings:manage` plus {@link ServicePrincipalForbiddenGuard} — a Service
 * Account can never widen its own (or another's) AI access, whatever it holds (ADR-0048, INV-SA-3). Every
 * change is audited in `ai_config_audit_log` with its author.
 *
 * The setting only narrows: it never grants a permission. The runtime also refuses, whatever the setting,
 * an account without `ai:use` or holding `infra:report` (ADR-0097 default 16).
 */
@ApiTags('config')
@Controller('config/ai/service-accounts')
@RequirePermission('settings:manage')
@UseGuards(ServicePrincipalForbiddenGuard)
export class AiServiceAccountAccessController {
  constructor(private readonly service: AiServiceAccountAccessService) {}

  @Get(':id')
  @ApiOperation({
    summary: "A Service Account's AI access (ADMIN — settings:manage)",
    description:
      '`{ access: off | read-only | read-write, maxMutationsPerRun: number | null }`. An account never ' +
      'configured reads as read-write with no cap.',
  })
  @ApiOkResponse({ type: AiServiceAccountSettingsDto })
  @ApiNotFoundResponse({ description: 'No such (live) Service Account.' })
  get(@Param('id') id: string): Promise<AiServiceAccountSettings> {
    return this.service.get(aiEntityId(id));
  }

  @Put(':id')
  @ApiOperation({
    summary: "Set a Service Account's AI access (ADMIN — settings:manage)",
    description:
      '`off` refuses every headless run of the account; `read-only` lists read tools only; `read-write` ' +
      'allows every tool its grants allow. `maxMutationsPerRun` caps executed writes per run (null = none). ' +
      'Applies at the next step of a running run. Audited.',
  })
  @ApiOkResponse({ type: AiServiceAccountSettingsDto })
  @ApiNotFoundResponse({ description: 'No such (live) Service Account.' })
  update(
    @Param('id') id: string,
    @Body() dto: AiServiceAccountSettingsDto,
    @CurrentUser() user?: User,
  ): Promise<AiServiceAccountSettings> {
    return this.service.update(aiEntityId(id), dto, user?.id ?? null);
  }
}
