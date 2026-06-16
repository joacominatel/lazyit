import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  AssetTagSchemeSchema,
  UpdateAssetTagSchemeSchema,
  type AssetTagScheme,
} from '@lazyit/shared';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ServicePrincipalForbiddenGuard } from '../auth/service-principal-forbidden.guard';
import { AssetTagSchemeService } from './asset-tag-scheme.service';

// DTOs from the shared zod schemas: validation (global ZodValidationPipe) + TS types + OpenAPI schema.
class AssetTagSchemeDto extends createZodDto(AssetTagSchemeSchema) {}
class UpdateAssetTagSchemeDto extends createZodDto(UpdateAssetTagSchemeSchema) {}

/**
 * AssetTagSchemeController — the settings surface for lazyit's first instance-config entity
 * (ADR-0063, #363). Lives under `/config/asset-tag-scheme` so it sits with the rest of the config
 * surface, but is provided by its own cohesive module (the service is also injected into
 * AssetsService for in-create allocation).
 *
 * Both handlers are gated by `settings:manage` (the instance-config admin permission) and forbidden
 * to service principals (a bot must never reconfigure the org-wide tag scheme), matching the
 * /config/permissions posture.
 */
@ApiTags('config')
@Controller('config/asset-tag-scheme')
export class AssetTagSchemeController {
  constructor(private readonly service: AssetTagSchemeService) {}

  @RequirePermission('settings:manage')
  @UseGuards(ServicePrincipalForbiddenGuard)
  @Get()
  @ApiOperation({
    summary: 'Read the asset-tag scheme (ADMIN — settings:manage)',
    description:
      'Returns the single AssetTagScheme config row, or its explicit UNSET/DISABLED default ' +
      '(enabled false, no affixes, nextNumber 1) when none has been configured — never a 404. ' +
      '`nextNumber` is the next sequence value that would be allocated. OFF by default (ADR-0063).',
  })
  @ApiOkResponse({ type: AssetTagSchemeDto })
  get(): Promise<AssetTagScheme> {
    return this.service.getScheme();
  }

  @RequirePermission('settings:manage')
  @UseGuards(ServicePrincipalForbiddenGuard)
  @Put()
  @ApiOperation({
    summary: 'Configure the asset-tag scheme (ADMIN — settings:manage)',
    description:
      'Upserts the single config row. `enabled` turns auto-allocation on/off (the deliberate ' +
      'config act). `prefix`/`suffix`/`width` shape the rendered tag `prefix + zeroPad(num,width) + ' +
      'suffix`. `startNumber` optionally (re)seeds the counter; omit it to leave the sequence where ' +
      'it is (toggling enabled never rewinds it). The running number is structural, so a scheme ' +
      'without a sequence is unrepresentable (the {num}-less reject of ADR-0063). Returns the scheme.',
  })
  @ApiOkResponse({ type: AssetTagSchemeDto })
  update(@Body() dto: UpdateAssetTagSchemeDto): Promise<AssetTagScheme> {
    return this.service.updateScheme(dto);
  }
}
