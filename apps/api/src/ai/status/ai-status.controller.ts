import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { AiStatusSchema, type AiStatus } from '@lazyit/shared';
import { CurrentPrincipal } from '../../auth/current-principal.decorator';
import type { Principal } from '../../auth/principal';
import { RequirePermission } from '../../auth/require-permission.decorator';
import { AiStatusService } from './ai-status.service';

class AiStatusDto extends createZodDto(AiStatusSchema) {}

/**
 * `GET /ai/status` — what the web shell gates the chat launcher on (synthesis §4.5). Any authenticated
 * caller, no permission gate (`@RequirePermission()` with no arguments, the `config#myPermissions`
 * precedent): the answer is computed for the caller and carries no secret, no provider, model or key
 * fact. A service account is refused by the RolesGuard's fail-closed rule for ungated routes (INV-SA-2).
 */
@ApiTags('ai')
@Controller('ai/status')
export class AiStatusController {
  constructor(private readonly service: AiStatusService) {}

  @Get()
  @RequirePermission()
  @ApiOperation({
    summary: "The caller's AI availability (any authenticated user)",
    description:
      '`{ chat: { available }, mcp: { available, auth }, configRevision, retentionDays }`. `chat.available` ' +
      '= enabled ∧ provider configured ∧ ai:use; `mcp.available` = the MCP switch ∧ ai:connect. No secrets.',
  })
  @ApiOkResponse({ type: AiStatusDto })
  get(@CurrentPrincipal() principal?: Principal): Promise<AiStatus> {
    return this.service.getStatus(principal);
  }
}
