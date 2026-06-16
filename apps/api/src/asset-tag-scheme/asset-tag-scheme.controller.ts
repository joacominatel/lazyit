import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  AssetTagBackfillApplySchema,
  AssetTagBackfillPreviewQuerySchema,
  AssetTagBackfillPreviewSchema,
  AssetTagBackfillResultSchema,
  AssetTagSchemeSchema,
  AssetTagSeedSuggestionQuerySchema,
  AssetTagSeedSuggestionSchema,
  UpdateAssetTagSchemeSchema,
  type AssetTagBackfillPreview,
  type AssetTagBackfillResult,
  type AssetTagScheme,
  type AssetTagSeedSuggestion,
} from '@lazyit/shared';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ServicePrincipalForbiddenGuard } from '../auth/service-principal-forbidden.guard';
import type { Principal } from '../auth/principal';
import { AssetTagSchemeService } from './asset-tag-scheme.service';

// DTOs from the shared zod schemas: validation (global ZodValidationPipe) + TS types + OpenAPI schema.
class AssetTagSchemeDto extends createZodDto(AssetTagSchemeSchema) {}
class UpdateAssetTagSchemeDto extends createZodDto(
  UpdateAssetTagSchemeSchema,
) {}
// ADR-0068 estate-awareness DTOs: the seed-suggestion query/response and the backfill preview
// query/response + apply body/result.
class AssetTagSeedSuggestionQueryDto extends createZodDto(
  AssetTagSeedSuggestionQuerySchema,
) {}
class AssetTagSeedSuggestionDto extends createZodDto(
  AssetTagSeedSuggestionSchema,
) {}
class AssetTagBackfillPreviewQueryDto extends createZodDto(
  AssetTagBackfillPreviewQuerySchema,
) {}
class AssetTagBackfillPreviewDto extends createZodDto(
  AssetTagBackfillPreviewSchema,
) {}
class AssetTagBackfillApplyDto extends createZodDto(
  AssetTagBackfillApplySchema,
) {}
class AssetTagBackfillResultDto extends createZodDto(
  AssetTagBackfillResultSchema,
) {}

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

  // --- ADR-0068: existing-estate awareness (seed suggestion + backfill) ------

  @RequirePermission('settings:manage')
  @UseGuards(ServicePrincipalForbiddenGuard)
  @Get('seed-suggestion')
  @ApiOperation({
    summary: 'Suggest a seed startNumber for the IN-PROGRESS affixes (ADMIN — settings:manage)',
    description:
      'Parses the numeric body out of LIVE asset tags matching the supplied (in-progress, ' +
      'not-yet-saved) `prefix … suffix` and returns `max + 1` as the suggested `startNumber`, so the ' +
      'counter seeds ABOVE the occupied range (ADR-0068 §2). Read-only — consumes no counter, writes ' +
      'nothing. Returns suggestedStartNumber=1 when nothing matches.',
  })
  @ApiOkResponse({ type: AssetTagSeedSuggestionDto })
  seedSuggestion(
    @Query() query: AssetTagSeedSuggestionQueryDto,
  ): Promise<AssetTagSeedSuggestion> {
    return this.service.seedSuggestion(query);
  }

  @RequirePermission('settings:manage')
  @UseGuards(ServicePrincipalForbiddenGuard)
  @Get('backfill/preview')
  @ApiOperation({
    summary: 'Preview the assets a backfill would retag (ADMIN — settings:manage)',
    description:
      'Read-only, paginated projection of exactly the live assets the given mode/scope would retag — ' +
      'WRITES NOTHING (the counter is not consumed; `proposedTag` is an indicative what-if). Modes: ' +
      '`untagged-only` (assets with no tag) or `normalize-non-conforming` (additionally tags that do ' +
      'not match the scheme). Optional `modelId` filter. 400 if the scheme is disabled (ADR-0068 §4).',
  })
  @ApiOkResponse({ type: AssetTagBackfillPreviewDto })
  backfillPreview(
    @Query() query: AssetTagBackfillPreviewQueryDto,
  ): Promise<AssetTagBackfillPreview> {
    return this.service.backfillPreview(query);
  }

  @RequirePermission('settings:manage')
  @UseGuards(ServicePrincipalForbiddenGuard)
  @Post('backfill/apply')
  @ApiOperation({
    summary: 'Apply a backfill — allocate-and-set tags for real (ADMIN — settings:manage)',
    description:
      'The deliberate, audited bulk retag: each affected live asset (matching mode/scope minus ' +
      '`excludeIds`) gets the next FREE tag under the skip-existing invariant, written with an ' +
      'AssetHistory row. FORWARD-ONLY, no undo; partial completion is acceptable (returns ' +
      '{ tagged, skipped }). 400 if the scheme is disabled (ADR-0068 §3).',
  })
  @ApiOkResponse({ type: AssetTagBackfillResultDto })
  backfillApply(
    @Body() dto: AssetTagBackfillApplyDto,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<AssetTagBackfillResult> {
    return this.service.backfillApply(dto, principal);
  }
}
