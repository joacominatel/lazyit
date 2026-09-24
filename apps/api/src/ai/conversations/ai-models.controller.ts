import { Controller, Get } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { AiModelCatalogSchema, type AiModelCatalog } from '@lazyit/shared';
import { CurrentPrincipal } from '../../auth/current-principal.decorator';
import type { Principal } from '../../auth/principal';
import { RequirePermission } from '../../auth/require-permission.decorator';
import { aiHumanIdentityOf } from './ai-request-identity';
import { AiModelCatalogService } from './ai-model-catalog.service';

class AiModelCatalogDto extends createZodDto(AiModelCatalogSchema) {}

/**
 * `GET /ai/models` (#1373) — the chat's model picker: `ai:use`, the human channel only (a Service Account
 * is refused 403, like `/ai/conversations`). 409 `AI_DISABLED` while the assistant is off.
 */
@ApiTags('ai')
@Controller('ai/models')
@RequirePermission('ai:use')
export class AiModelsController {
  constructor(private readonly catalog: AiModelCatalogService) {}

  @Get()
  @ApiOperation({
    summary: 'The models a conversation may use (ai:use)',
    description:
      'The configured provider’s models (listed from the provider, cached 10 minutes), the admin’s default ' +
      'model and effort, whether a per-conversation effort is supported, and the provider option keys. A ' +
      'custom model id may still be typed. `listed: false` + `listingError` when the provider could not be ' +
      'listed. 409 AI_DISABLED while the assistant is off.',
  })
  @ApiOkResponse({ type: AiModelCatalogDto })
  @ApiConflictResponse({ description: 'AI_DISABLED' })
  get(@CurrentPrincipal() principal?: Principal): Promise<AiModelCatalog> {
    aiHumanIdentityOf(principal);
    return this.catalog.catalog();
  }
}
